const { getClient } = require('./_db');
const { createId } = require('./_ids');
const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');
const { createAuditEvent } = require('./_audit-outbox');
const { displayId } = require('./_ids');

function maskAccount(value) {
  const text = String(value || '');
  return text.length <= 4 ? '••••' : `${text.slice(0, 4)}••••${text.slice(-2)}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { transaction_id, consent } = req.body;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  let identity;
  try { if (!token) throw new Error(); identity = jwt.verify(token, getRequiredEnv('JWT_SECRET')); } catch { return res.status(401).json({ error: 'Authenticated receiver authorization is required.' }); }
  if (!transaction_id || consent !== true) {
    return res.status(400).json({ error: 'Receiver identity and consent are required.' });
  }

  try {
    const client = await getClient();
    const session = client.startSession();
    let settledBalance;
    let auditEventId;
    try {
      await session.withTransaction(async () => {
        const db = client.db(process.env.MONGODB_DB_NAME || 'securepay');
        const transaction = await db.collection('transactions').findOne({ _id: transaction_id }, { session });
        if (!transaction) throw Object.assign(new Error('Transaction not found.'), { statusCode: 404 });
        if (!['PENDING', 'PENDING_TRUSTED'].includes(transaction.status)) {
          throw Object.assign(new Error('This payment is no longer awaiting approval.'), { statusCode: 409 });
        }
        const receiverUser = await db.collection('users').findOne({ _id: identity.user_id }, { session });
        const receiverAccount = receiverUser && await db.collection('accounts').findOne({ user_id: receiverUser._id }, { session });
        if (!receiverUser || Number(identity.token_version || 0) !== Number(receiverUser.token_version || 0) || receiverUser.account_status === 'SUSPENDED') throw Object.assign(new Error('Receiver authorization is no longer valid.'), { statusCode: 403 });
        if (!receiverAccount || receiverAccount._id !== transaction.receiver_account_id) {
          throw Object.assign(new Error('This payment is not addressed to the signed-in receiver.'), { statusCode: 403 });
        }
        if (receiverUser.account_status === 'SUSPENDED' || receiverAccount.status === 'SUSPENDED') throw Object.assign(new Error('This receiver account is suspended.'), { statusCode: 403 });

        // Transactions created by the previous implementation already moved funds.
        // Only new transactions explicitly marked false should move funds here.
        if (transaction.funds_reserved === false) {
          const debit = await db.collection('accounts').updateOne(
            { _id: transaction.sender_account_id, balance: { $gte: Number(transaction.amount) } },
            { $inc: { balance: -Number(transaction.amount) } },
            { session }
          );
          if (debit.modifiedCount !== 1) throw new Error('Sender has insufficient funds to settle this payment.');
          await db.collection('accounts').updateOne(
            { _id: transaction.receiver_account_id },
            { $inc: { balance: Number(transaction.amount) } },
            { session }
          );
        }

        const updated = await db.collection('transactions').findOneAndUpdate(
          { _id: transaction_id, status: { $in: ['PENDING', 'PENDING_TRUSTED'] } },
          { $set: { status: 'COMPLETED', funds_reserved: true, completed_at: new Date() } },
          { session, returnDocument: 'after' }
        );
        if (!updated) throw Object.assign(new Error('Payment was already approved.'), { statusCode: 409 });
        const receiver = await db.collection('accounts').findOne({ _id: transaction.receiver_account_id }, { session });
        settledBalance = receiver ? Number(receiver.balance) : undefined;
        const senderAccount = await db.collection('accounts').findOne({ _id: transaction.sender_account_id }, { session });
        const senderUser = senderAccount && await db.collection('users').findOne({ _id: senderAccount.user_id }, { session });
        auditEventId = createId('AUDIT');
        await createAuditEvent(db, session, {
          _id: auditEventId,
          event_type: 'TRANSFER_COMPLETED',
          transaction_id: transaction._id,
          transaction_reference: displayId(transaction.transaction_reference || transaction._id, 'TXN'),
          user_id: receiverUser._id,
          sender_user_id: senderUser?._id || null,
          receiver_user_id: receiverUser._id,
          sender_name: senderUser?.full_name || 'Not available',
          sender_email: senderUser?.email || 'Not available',
          receiver_name: receiverUser.full_name || 'Not available',
          receiver_email: receiverUser.email || 'Not available',
          sender_account: maskAccount(senderAccount?.account_number),
          receiver_account: maskAccount(receiverAccount.account_number),
          user_name: receiverUser.full_name || 'Not available',
          user_email: receiverUser.email || 'Not available',
          account_number_masked: maskAccount(receiverAccount.account_number),
          audit_party: 'RECEIVER',
          amount_cents: Math.round(Number(transaction.amount) * 100),
          currency: 'INR',
          transaction_type: transaction.transaction_type || 'INTERNAL_TRANSFER',
          final_status: 'COMPLETED',
          actor_id: receiverUser._id,
          actor_role: 'CUSTOMER',
          outcome: 'COMPLETED'
        });
      });
    } finally {
      await session.endSession();
    }
    return res.status(200).json({ success: true, message: 'Transfer settled after receiver approval.', balance: settledBalance, transaction_reference: displayId(transaction_id, 'TXN'), audit_event_id: auditEventId });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};
