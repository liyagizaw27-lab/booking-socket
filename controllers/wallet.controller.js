const { Wallet, Transaction } = require('../models/common');
const { DirectPayment } = require('../integrations/santimpay');

exports.topup = async (req, res) => {
  try {
    const { amount, paymentMethod, reason = 'Wallet Topup' } = req.body || {};
    if (!amount || amount <= 0) return res.status(400).json({ message: 'amount must be > 0' });
    // Phone must come from token
    const tokenPhone = req.user && (req.user.phone || req.user.phoneNumber || req.user.mobile);
    if (!tokenPhone) return res.status(400).json({ message: 'phoneNumber missing in token' });
    const normalizeMsisdnEt = (raw) => {
      if (!raw) return null;
      let s = String(raw).trim();
      s = s.replace(/\s+/g, '').replace(/[-()]/g, '');
      // Replace leading 0 with +251, or 251 without +, or keep +251
      if (/^\+?251/.test(s)) {
        s = s.replace(/^\+?251/, '+251');
      } else if (/^0\d+/.test(s)) {
        s = s.replace(/^0/, '+251');
      } else if (/^9\d{8}$/.test(s)) {
        s = '+251' + s;
      }
      // Final validation: +2519XXXXXXXX (total length 13)
      if (!/^\+2519\d{8}$/.test(s)) return null;
      return s;
    };
    const msisdn = normalizeMsisdnEt(tokenPhone);
    if (!msisdn) return res.status(400).json({ message: 'Invalid phone format in token. Required: +2519XXXXXXXX' });

    const userId = String(req.user.id);
    const role = req.user.type;

    let wallet = await Wallet.findOne({ userId, role });
    if (!wallet) wallet = await Wallet.create({ userId, role, balance: 0 });

    const tx = await Transaction.create({
      txnId: undefined,
      refId: undefined,
      userId,
      role,
      amount,
      type: 'credit',
      method: 'santimpay',
      status: 'pending',
      msisdn: msisdn,
      metadata: { reason }
    });
    await tx.save();

    // Normalize payment method for SantimPay API (avoid unsupported values)
    const normalizePaymentMethod = (method) => {
      const m = String(method || '').trim().toLowerCase();
      if (m === 'telebirr' || m === 'tele') return 'Telebirr';
      if (m === 'cbe' || m === 'cbe-birr' || m === 'cbebirr') return 'CBE';
      if (m === 'hellocash' || m === 'hello-cash') return 'HelloCash';
      // Default to Telebirr if missing or unsupported
      return 'Telebirr';
    };
    const methodForGateway = normalizePaymentMethod(paymentMethod);

    const notifyUrl = process.env.SANTIMPAY_NOTIFY_URL ;
    const response = await DirectPayment(String(tx._id), amount, reason, notifyUrl, msisdn, methodForGateway);

    // Store gateway response minimal data
    await Transaction.findByIdAndUpdate(tx._id, { metadata: { ...tx.metadata, gatewayResponse: response, txnId:response.data.TxnId } });

    return res.status(202).json({ message: 'Topup initiated', transactionId: String(tx._id) });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.webhook = async (req, res) => {
  try {
    // Expect SantimPay to call with fields including ID, Status, Commission, TotalAmount, Msisdn, TxnId, RefId
    const body = req.body || {};
    const id = body.ID || body.id;
    if (!id) return res.status(400).json({ message: 'Invalid webhook payload' });

    const tx = await Transaction.findById(id);
    if (!tx) return res.status(404).json({ message: 'Transaction not found' });

    const status = (body.Status || body.status || '').toString().toLowerCase();
    const normalizedStatus = status.includes('success') ? 'success' : status.includes('fail') ? 'failed' : 'pending';

    tx.txnId = body.TxnId || body.txnId || tx.txnId;
    tx.refId = body.RefId || body.refId || tx.refId;
    tx.status = normalizedStatus;
    tx.commission = body.Commission != null ? Number(body.Commission) : tx.commission;
    tx.totalAmount = body.TotalAmount != null ? Number(body.TotalAmount) : tx.totalAmount;
    tx.msisdn = body.Msisdn || body.msisdn || tx.msisdn;
    tx.metadata = { ...tx.metadata, webhook: body };
    await tx.save();

    if (normalizedStatus === 'success') {
      // Credit wallet atomically; record credit transaction if not already credited via tx
      await Wallet.updateOne({ userId: tx.userId, role: tx.role }, { $inc: { balance: tx.amount } }, { upsert: true });
    }

    // Respond with concise, important fields only
    return res.json({
      ok: true,
      txnId: body.TxnId || body.txnId,
      refId: body.RefId || body.refId,
      status: (body.Status || body.status),
      statusReason: body.StatusReason || body.message,
      amount: body.amount || body.Amount || body.TotalAmount,
      currency: body.currency || body.Currency || 'ETB',
      msisdn: body.Msisdn || body.msisdn,
      paymentVia: body.paymentVia || body.PaymentMethod,
      message: body.message,
      updateType: body.updateType || body.UpdateType
    });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.transactions = async (req, res) => {
  try {
    const userId = req.params.userId || req.user.id;
    const rows = await Transaction.find({ userId: String(userId) }).sort({ createdAt: -1 }).lean();
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.withdraw = async (req, res) => {
  try {
    const { amount, destination, method = 'santimpay' } = req.body || {};
    if (!amount || amount <= 0) return res.status(400).json({ message: 'amount must be > 0' });

    const userId = String(req.user.id);
    const role = 'driver';
    if (req.user.type !== 'driver') return res.status(403).json({ message: 'Only drivers can withdraw' });

    const wallet = await Wallet.findOne({ userId, role });
    if (!wallet || wallet.balance < amount) return res.status(400).json({ message: 'Insufficient balance' });

    const tx = await Transaction.create({
      userId,
      role,
      amount,
      type: 'debit',
      method,
      status: 'pending',
      metadata: { destination }
    });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};
