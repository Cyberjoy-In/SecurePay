const { getClient } = require('./_db');
const { createId } = require('./_ids');
const { requireUser, verifyRequest } = require('./_auth');
const { createAuditEvent } = require('./_audit-outbox');

function badRequest(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode, expose: true }); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try { verifyRequest(req); } catch (error) { return res.status(error.statusCode || 401).json({ error: error.message }); }
  const body = req.body || {};
  const type = String(body.type || '').trim().toLowerCase();
  const reference = String(body.accountNumber || '').trim();
  const amount = Number(body.amount);
  const key = String(req.headers['idempotency-key'] || body.idempotency_key || '').trim();
  if (!['mobile', 'electricity', 'water', 'broadband', 'dth'].includes(type)) return res.status(400).json({ error: 'Unsupported bill-payment type.' });
  if (!reference || reference.length > 80) return res.status(400).json({ error: 'A valid bill or service reference is required.' });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) return res.status(400).json({ error: 'Enter a valid payment amount.' });
  if (!key) return res.status(400).json({ error: 'An idempotency key is required for simulated bill payments.' });
  try {
    const client = await getClient();
    const db = client.db(process.env.MONGODB_DB_NAME || 'securepay');
    await db.collection('financial_transactions').createIndex({ user_id: 1, idempotency_key: 1, type: 1 }, { unique: true, partialFilterExpression: { idempotency_key: { $exists: true } } });
    const session = client.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const { user } = await requireUser(req, db);
        const account = await db.collection('accounts').findOne({ user_id: user._id, status: { $ne: 'SUSPENDED' } }, { session });
        if (!account) badRequest('Active account not found.', 404);
        const existing = await db.collection('financial_transactions').findOne({ user_id: user._id, idempotency_key: key, type: 'SIMULATED_BBPS_PAYMENT' }, { session });
        if (existing) { result = { transactionId: existing._id, amount: Number(existing.amount_cents) / 100, providerDetected: existing.provider, status: existing.status, simulated: true, idempotent: true }; return; }
        const amountCents = Math.round(amount * 100);
        const debit = await db.collection('accounts').updateOne({ _id: account._id, user_id: user._id, balance: { $gte: amount } }, { $inc: { balance: -amount } }, { session });
        if (debit.modifiedCount !== 1) badRequest('Insufficient account balance.');
        const provider = type === 'mobile' ? 'SIMULATED_MOBILE_PROVIDER' : `SIMULATED_${type.toUpperCase()}_PROVIDER`;
        const transactionId = createId('TXN');
        await db.collection('financial_transactions').insertOne({ _id: transactionId, user_id: user._id, account_id: account._id, type: 'SIMULATED_BBPS_PAYMENT', bill_type: type, service_reference_last4: reference.slice(-4), provider, idempotency_key: key, amount_cents: amountCents, status: 'SIMULATED_COMPLETED', created_at: new Date() }, { session });
        const auditEventId = createId('AUDIT');
        await createAuditEvent(db, session, { _id: auditEventId, event_type: 'SIMULATED_BBPS_PAYMENT', user_id: user._id, actor_id: user._id, actor_role: String(user.role || 'customer').toUpperCase(), transaction_id: transactionId, amount_cents: amountCents, outcome: 'SIMULATED_COMPLETED', provider, bill_type: type }, { auditReady: true });
        result = { transactionId, audit_event_id: auditEventId, amount, providerDetected: provider, status: 'SIMULATED_COMPLETED', simulated: true, new_balance: Number(account.balance) - amount };
      });
      return res.status(200).json({ success: true, message: `Simulated ${type} payment recorded for service reference ending ${reference.slice(-4)}.`, ...result });
    } finally { await session.endSession(); }
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'This bill payment request was already processed.' });
    return res.status(error.statusCode || 500).json({ error: error.expose || error.statusCode ? error.message : 'Simulated bill payment could not be completed.' });
  }
};
