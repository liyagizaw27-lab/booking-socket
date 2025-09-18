const mongoose = require('mongoose');
const { Wallet, Transaction } = require('../models/common');

exports.getWallet = async (req, res) => {
  try {
    const driverId = req.params.id;
    console.log('[wallet] getWallet for driver:', String(driverId));
    const wallet = await Wallet.findOne({ userId: String(driverId), role: 'driver' }).lean();
    return res.json(wallet || { userId: String(driverId), role: 'driver', balance: 0, totalEarnings: 0, currency: 'ETB' });
  } catch (e) { return res.status(500).json({ message: e.message }); }
};

exports.adjustBalance = async (req, res) => {
  try {
    const driverId = req.params.id;
    const { amount, reason = 'Admin Adjustment' } = req.body || {};
    if (!amount || amount === 0) return res.status(400).json({ message: 'amount must be non-zero' });

    const txType = amount > 0 ? 'credit' : 'debit';
    const absAmount = Math.abs(Number(amount));

    const session = await mongoose.startSession();
    let out;
    await session.withTransaction(async () => {
      console.log('[wallet-admin] adjustBalance start:', { driverId: String(driverId), amount: Number(amount), reason });

      // Create transaction record for audit
      const tx = await Transaction.create([
        {
          userId: String(driverId),
          role: 'driver',
          amount: absAmount,
          type: txType,
          method: 'cash',
          status: 'success',
          metadata: { reason, operationType: 'adjustment' }
        }
      ], { session });
      const txDoc = Array.isArray(tx) ? tx[0] : tx;

      // Update wallet balance
      const update = amount > 0 ? { $inc: { balance: absAmount } } : { $inc: { balance: -absAmount } };
      const wallet = await Wallet.findOneAndUpdate(
        { userId: String(driverId), role: 'driver' },
        update,
        { new: true, upsert: true, session }
      );

      console.log('[wallet-admin] adjustBalance completed:', { driverId: String(driverId), newBalance: wallet.balance, transactionId: String(txDoc._id) });
      out = { wallet, transactionId: String(txDoc._id) };
    });
    session.endSession();
    return res.json(out);
  } catch (e) { return res.status(500).json({ message: e.message }); }
};

exports.listTransactions = async (req, res) => {
  try {
    const driverId = req.params.id;
    console.log('[wallet] listTransactions for driver:', String(driverId));
    const rows = await Transaction.find({ userId: String(driverId), role: 'driver' }).sort({ createdAt: -1 }).lean();
    return res.json(rows);
  } catch (e) { return res.status(500).json({ message: e.message }); }
};

// Withdraw funds: POST /drivers/:id/wallet/withdraw
exports.withdraw = async (req, res) => {
  try {
    const driverId = req.params.id;
    const { amount, destination, method = 'cash' } = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ message: 'amount must be > 0' });

    const session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      console.log('[wallet] withdraw start:', { driverId: String(driverId), amount: amt, destination, method });
      const wallet = await Wallet.findOne({ userId: String(driverId), role: 'driver' }).session(session);
      if (!wallet || wallet.balance < amt) throw new Error('Insufficient balance');

      const updated = await Wallet.findOneAndUpdate(
        { userId: String(driverId), role: 'driver' },
        { $inc: { balance: -amt } },
        { new: true, session }
      );
      const tx = await Transaction.create([
        { userId: String(driverId), role: 'driver', amount: amt, type: 'debit', method, status: 'success', metadata: { destination, operationType: 'withdrawal' } }
      ], { session });
      const txDoc = Array.isArray(tx) ? tx[0] : tx;
      console.log('[wallet] withdraw completed:', { driverId: String(driverId), newBalance: updated.balance, transactionId: String(txDoc._id) });
      result = { wallet: updated, transactionId: String(txDoc._id) };
    });
    session.endSession();
    return res.json(result);
  } catch (e) {
    const code = /insufficient/i.test(String(e.message)) ? 400 : 500;
    return res.status(code).json({ message: e.message });
  }
};

// Admin: list all driver wallets with optional filters
exports.adminListWallets = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '50', 10), 1), 200);
    const skip = (page - 1) * pageSize;
    const minBalance = req.query.minBalance != null ? Number(req.query.minBalance) : undefined;
    const driverId = req.query.driverId ? String(req.query.driverId) : undefined;

    const filter = { role: 'driver' };
    if (driverId) filter.userId = driverId;
    if (Number.isFinite(minBalance)) filter.balance = { $gte: minBalance };

    console.log('[wallet-admin] list wallets filter:', filter);
    const [items, total] = await Promise.all([
      Wallet.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(pageSize).lean(),
      Wallet.countDocuments(filter),
    ]);
    return res.json({ items, page, pageSize, total });
  } catch (e) { return res.status(500).json({ message: e.message }); }
};

// Admin: get driver wallet and transactions
exports.adminGetDriverWallet = async (req, res) => {
  try {
    const driverId = String(req.params.driverId);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10), 1), 500);
    const [wallet, txs] = await Promise.all([
      Wallet.findOne({ userId: driverId, role: 'driver' }).lean(),
      Transaction.find({ userId: driverId, role: 'driver' }).sort({ createdAt: -1 }).limit(limit).lean(),
    ]);
    return res.json({ wallet: wallet || { userId: driverId, role: 'driver', balance: 0, totalEarnings: 0, currency: 'ETB' }, transactions: txs });
  } catch (e) { return res.status(500).json({ message: e.message }); }
};

