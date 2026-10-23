const { getClient } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { transaction_id, receiver_email, consent } = req.body;
  if (!transaction_id || !receiver_email || consent !== true) {
    return res.status(400).json({ error: 'Receiver identity and consent are required.' });
  }

  try {
    const client = await getClient();
    const session = client.startSession();
    let settledBalance;
    try {
      await session.withTransaction(async () => {
        const db = client.db(process.env.MONGODB_DB_NAME || 'securepay');
        const transaction = await db.collection('transactions').findOne({ _id: transaction_id }, { session });
        if (!transaction) throw Object.assign(new Error('Transaction not found.'), { statusCode: 404 });
        if (!['PENDING', 'PENDING_TRUSTED'].includes(transaction.status)) {
          throw Object.assign(new Error('This payment is no longer awaiting approval.'), { statusCode: 409 });
        }
        const receiverUser = await db.collection('users').findOne({ email: receiver_email }, { session });
        const receiverAccount = receiverUser && await db.collection('accounts').findOne({ user_id: receiverUser._id }, { session });
        if (!receiverAccount || receiverAccount._id !== transaction.receiver_account_id) {
          throw Object.assign(new Error('This payment is not addressed to the signed-in receiver.'), { statusCode: 403 });
        }

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
      });
    } finally {
      await session.endSession();
    }
    return res.status(200).json({ success: true, message: 'Transfer settled after receiver approval.', balance: settledBalance });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};
