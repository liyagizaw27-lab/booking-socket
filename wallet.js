// wallet.js
// Driver Wallet System: Mongoose models, controllers, and Express routes
// Tech: Node.js, Express, Mongoose

const express = require('express');
const mongoose = require('mongoose');

// Reuse existing app models when present
let Booking;
try {
  // Align with existing booking model that uses String driverId and booking ObjectId
  Booking = require('./models/bookingModels').Booking;
} catch (_) {
  // Optional fallback if not available in this environment
  Booking = null;
}

// ----------------------
// Mongoose Models
// ----------------------

const DriverWalletSchema = new mongoose.Schema(
  {
    // Note: In this codebase the Driver `_id` is a String.
    driverId: { type: String, ref: 'Driver', required: true, index: true },
    balance: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    currency: { type: String, default: 'ETB' },
  },
  { timestamps: true, toJSON: { versionKey: false }, toObject: { versionKey: false } }
);

DriverWalletSchema.index({ driverId: 1 }, { unique: true });

const WalletTransactionSchema = new mongoose.Schema(
  {
    driverId: { type: String, ref: 'Driver', required: true, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    type: { type: String, enum: ['deposit', 'withdrawal', 'adjustment'], required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'completed', index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, toJSON: { versionKey: false }, toObject: { versionKey: false } }
);

const DriverWallet = mongoose.models.DriverWallet || mongoose.model('DriverWallet', DriverWalletSchema);
const WalletTransaction = mongoose.models.WalletTransaction || mongoose.model('WalletTransaction', WalletTransactionSchema);

// ----------------------
// Helpers
// ----------------------

async function getOrCreateWallet(driverId, session) {
  const findOpts = session ? { session } : undefined;
  let wallet = await DriverWallet.findOne({ driverId: String(driverId) }, undefined, findOpts);
  if (!wallet) {
    console.log('[wallet] Creating wallet for driver:', String(driverId));
    wallet = await DriverWallet.create([{ driverId: String(driverId), balance: 0, totalEarnings: 0 }], findOpts);
    wallet = Array.isArray(wallet) ? wallet[0] : wallet;
  }
  return wallet;
}

function parsePositiveAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ----------------------
// Controllers
// ----------------------

// POST /bookings/:id/complete -> credit driver wallet
async function completeBookingAndCredit(req, res) {
  const bookingId = req.params.id;
  try {
    if (!Booking) return res.status(500).json({ message: 'Booking model not available' });
    console.log('[wallet] Booking completion requested for booking:', bookingId);
    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (!booking.driverId) return res.status(400).json({ message: 'Booking has no driver assigned' });

    // Determine fare amount to credit. Prefer final fare, fallback to estimated
    const fare = Number(booking.fareFinal != null ? booking.fareFinal : booking.fareEstimated) || 0;
    if (fare <= 0) return res.status(400).json({ message: 'Invalid fare to credit' });

    const session = await mongoose.startSession();
    let responsePayload;
    await session.withTransaction(async () => {
      const driverId = String(booking.driverId);
      console.log('[wallet] Credit deposit start:', { driverId, bookingId: String(booking._id), fare });

      // Upsert wallet and increment balance and totalEarnings
      const update = { $inc: { balance: fare, totalEarnings: fare } };
      const wallet = await DriverWallet.findOneAndUpdate(
        { driverId },
        update,
        { new: true, upsert: true, session, setDefaultsOnInsert: true }
      );

      // Insert transaction record
      const tx = await WalletTransaction.create([
        { driverId, bookingId: booking._id, type: 'deposit', amount: fare, status: 'completed' }
      ], { session });
      const txDoc = Array.isArray(tx) ? tx[0] : tx;

      console.log('[wallet] Deposit completed:', { driverId, walletBalance: wallet.balance, totalEarnings: wallet.totalEarnings, transactionId: String(txDoc._id) });
      responsePayload = { wallet, transaction: txDoc };
    });
    session.endSession();
    return res.json(responsePayload);
  } catch (err) {
    console.error('[wallet] completeBookingAndCredit error:', err);
    return res.status(500).json({ message: err.message || 'Failed to credit wallet on booking completion' });
  }
}

// GET /drivers/:id/wallet -> get balance + transactions
async function getDriverWalletAndTransactions(req, res) {
  try {
    const driverId = String(req.params.id);
    console.log('[wallet] Fetch wallet & transactions for driver:', driverId);
    const wallet = await DriverWallet.findOne({ driverId }).lean();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const txs = await WalletTransaction.find({ driverId }).sort({ createdAt: -1 }).limit(limit).lean();
    return res.json({ wallet: wallet || { driverId, balance: 0, totalEarnings: 0, currency: 'ETB' }, transactions: txs });
  } catch (err) {
    console.error('[wallet] getDriverWalletAndTransactions error:', err);
    return res.status(500).json({ message: err.message });
  }
}

// POST /drivers/:id/wallet/withdraw -> withdraw funds
async function requestWithdrawal(req, res) {
  const driverId = String(req.params.id);
  try {
    const rawAmount = req.body && req.body.amount;
    const amount = parsePositiveAmount(rawAmount);
    if (!amount) return res.status(400).json({ message: 'amount must be > 0' });

    const session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      console.log('[wallet] Withdrawal request start:', { driverId, amount });
      const wallet = await getOrCreateWallet(driverId, session);
      if (wallet.balance < amount) {
        throw new Error('Insufficient balance');
      }
      // Deduct immediately and create transaction
      const updated = await DriverWallet.findOneAndUpdate(
        { driverId },
        { $inc: { balance: -amount } },
        { new: true, session }
      );
      const tx = await WalletTransaction.create([
        { driverId, type: 'withdrawal', amount, status: 'completed' }
      ], { session });
      const txDoc = Array.isArray(tx) ? tx[0] : tx;
      console.log('[wallet] Withdrawal completed:', { driverId, amount, newBalance: updated.balance, transactionId: String(txDoc._id) });
      result = { wallet: updated, transaction: txDoc };
    });
    session.endSession();
    return res.json(result);
  } catch (err) {
    console.error('[wallet] requestWithdrawal error:', err);
    const code = /insufficient/i.test(err.message) ? 400 : 500;
    return res.status(code).json({ message: err.message });
  }
}

// GET /admin/wallets -> list all driver wallets
async function adminListWallets(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '50', 10), 1), 200);
    const skip = (page - 1) * pageSize;
    const minBalance = req.query.minBalance != null ? Number(req.query.minBalance) : undefined;
    const driverId = req.query.driverId ? String(req.query.driverId) : undefined;

    const filter = {};
    if (driverId) filter.driverId = driverId;
    if (Number.isFinite(minBalance)) filter.balance = { $gte: minBalance };

    console.log('[wallet-admin] List wallets filter:', filter);
    const [items, total] = await Promise.all([
      DriverWallet.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(pageSize).lean(),
      DriverWallet.countDocuments(filter),
    ]);
    return res.json({ items, page, pageSize, total });
  } catch (err) {
    console.error('[wallet-admin] adminListWallets error:', err);
    return res.status(500).json({ message: err.message });
  }
}

// GET /admin/wallets/:driverId -> view wallet + transactions
async function adminGetDriverWallet(req, res) {
  try {
    const driverId = String(req.params.driverId);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 500);
    console.log('[wallet-admin] Get wallet+tx for driver:', driverId);
    const [wallet, txs] = await Promise.all([
      DriverWallet.findOne({ driverId }).lean(),
      WalletTransaction.find({ driverId }).sort({ createdAt: -1 }).limit(limit).lean(),
    ]);
    return res.json({ wallet: wallet || { driverId, balance: 0, totalEarnings: 0, currency: 'ETB' }, transactions: txs });
  } catch (err) {
    console.error('[wallet-admin] adminGetDriverWallet error:', err);
    return res.status(500).json({ message: err.message });
  }
}

// POST /admin/wallets/:driverId/adjust -> manually adjust balance
async function adminAdjustWallet(req, res) {
  const driverId = String(req.params.driverId);
  try {
    const rawAmount = req.body && req.body.amount;
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ message: 'amount must be non-zero' });
    const reason = (req.body && req.body.reason) || 'Admin adjustment';

    const session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      console.log('[wallet-admin] Adjustment start:', { driverId, amount, reason });
      await getOrCreateWallet(driverId, session);
      const updated = await DriverWallet.findOneAndUpdate(
        { driverId },
        { $inc: { balance: amount } },
        { new: true, session }
      );
      const tx = await WalletTransaction.create([
        { driverId, type: 'adjustment', amount: Math.abs(amount), status: 'completed' }
      ], { session });
      const txDoc = Array.isArray(tx) ? tx[0] : tx;
      console.log('[wallet-admin] Adjustment completed:', { driverId, amount, newBalance: updated.balance, transactionId: String(txDoc._id), reason });
      result = { wallet: updated, transaction: txDoc };
    });
    session.endSession();
    return res.json(result);
  } catch (err) {
    console.error('[wallet-admin] adminAdjustWallet error:', err);
    return res.status(500).json({ message: err.message });
  }
}

// ----------------------
// Express Router
// ----------------------

const router = express.Router();

// Passenger completes ride & pays -> credit driver wallet
router.post('/bookings/:id/complete', completeBookingAndCredit);

// Driver wallet endpoints
router.get('/drivers/:id/wallet', getDriverWalletAndTransactions);
router.post('/drivers/:id/wallet/withdraw', requestWithdrawal);

// Admin endpoints
router.get('/admin/wallets', adminListWallets);
router.get('/admin/wallets/:driverId', adminGetDriverWallet);
router.post('/admin/wallets/:driverId/adjust', adminAdjustWallet);

module.exports = {
  DriverWallet,
  WalletTransaction,
  walletRouter: router,
};

