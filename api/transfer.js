const { getClient, getDatabase } = require('./_db');
const { createId } = require('./_ids');
const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');
const { createAuditEvent } = require('./_audit-outbox');

function maskAccount(value) {
  const text = String(value || '');
  return text.length <= 4 ? '••••' : `${text.slice(0, 4)}••••${text.slice(-2)}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { receiver_account_number, amount } = req.body;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  let identity;
  try { if (!token) throw new Error(); identity = jwt.verify(token, getRequiredEnv('JWT_SECRET')); } catch { return res.status(401).json({ success: false, error: 'Authenticated transfer authorization is required.' }); }
  const transferAmount = parseFloat(amount);
  if (!Number.isFinite(transferAmount) || transferAmount <= 0) return res.status(400).json({ success: false, error: 'Invalid transfer amount.' });
  const client = await getClient();
  const database = client.db(process.env.MONGODB_DB_NAME || 'securepay');
  try { await database.collection('transactions').createIndex({ sender_account_id: 1, idempotency_key: 1 }, { unique: true, partialFilterExpression: { idempotency_key: { $exists: true } } }); } catch { return res.status(500).json({ success: false, error: 'Transfer data preparation failed.' }); }
  const session = client.startSession();

  try {
    let transaction;
    await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB_NAME || 'securepay');
      const senderUser = await db.collection('users').findOne({ _id: identity.user_id }, { session });
      const sender = senderUser && await db.collection('accounts').findOne({ user_id: senderUser._id }, { session });
      if (!sender) throw new Error('Sender account not found.');
      if (senderUser.account_status === 'SUSPENDED' || sender.status === 'SUSPENDED') throw new Error('This account is suspended. Transfers are unavailable.');

      const receiver = await db.collection('accounts').findOne({ account_number: receiver_account_number }, { session });
      if (!receiver) throw new Error('Receiver account not registered.');
      if (sender._id === receiver._id) throw new Error('Sender and receiver accounts must be different.');
      const receiverUser = await db.collection('users').findOne({ _id: receiver.user_id }, { session });
      if (!receiverUser) throw new Error('Receiver identity could not be verified.');
      const idempotencyKey = String(req.headers['idempotency-key'] || req.body?.idempotency_key || '').trim();
      if (idempotencyKey) {
        const existing = await db.collection('transactions').findOne({ sender_account_id: sender._id, idempotency_key: idempotencyKey }, { session });
        if (existing) { transaction = { ...existing, is_trusted: existing.status === 'PENDING_TRUSTED', idempotent: true }; return; }
      }

      const trustCheck = await db.collection('transactions').findOne({
        $or: [
          { sender_account_id: sender._id, receiver_account_id: receiver._id },
          { sender_account_id: receiver._id, receiver_account_id: sender._id }
        ],
        status: 'COMPLETED'
      }, { session });
      const isTrusted = Boolean(trustCheck);
      if (Number(sender.balance) < transferAmount) throw new Error('Insufficient account balance.');
      transaction = {
        _id: createId('TXN'),
        sender_account_id: sender._id,
        receiver_account_id: receiver._id,
        amount: transferAmount,
        status: isTrusted ? 'PENDING_TRUSTED' : 'PENDING',
        created_at: new Date(),
        // Funds remain in both accounts until the receiver completes consent and approval.
        funds_reserved: false,
        new_balance: Number(sender.balance),
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        transaction_type: 'INTERNAL_TRANSFER'
      };
      await db.collection('transactions').insertOne(transaction, { session });
      const auditEventId = createId('AUDIT');
      transaction.audit_event_id = auditEventId;
      await db.collection('transactions').updateOne({ _id: transaction._id }, { $set: { audit_event_id: auditEventId } }, { session });
      await createAuditEvent(db, session, {
        _id: auditEventId,
        event_type: 'TRANSFER_INITIATED',
        transaction_id: transaction._id,
        user_id: senderUser._id,
        sender_user_id: senderUser._id,
        receiver_user_id: receiverUser._id,
        sender_name: senderUser.full_name || 'Not available',
        receiver_name: receiverUser.full_name || 'Not available',
        sender_account: maskAccount(sender.account_number),
        receiver_account: maskAccount(receiver.account_number),
        amount_cents: Math.round(transferAmount * 100),
        currency: 'INR',
        transaction_type: 'INTERNAL_TRANSFER',
        final_status: transaction.status,
        actor_id: senderUser._id,
        actor_role: 'CUSTOMER',
        outcome: 'PENDING',
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
      });
      transaction.is_trusted = isTrusted;
    });
    
    return res.status(200).json({ 
      success: true, 
      transaction_id: transaction._id,
      new_balance: transaction.new_balance,
      is_trusted: transaction.is_trusted,
      audit_event_id: transaction.audit_event_id,
      idempotent: transaction.idempotent === true
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  } finally {
    await session.endSession();
  }
};
