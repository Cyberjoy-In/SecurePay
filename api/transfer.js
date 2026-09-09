const { getClient, getDatabase } = require('./_db');
const { createId } = require('./_ids');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sender_email, receiver_account_number, amount } = req.body;
  const transferAmount = parseFloat(amount);
  if (!Number.isFinite(transferAmount) || transferAmount <= 0) return res.status(400).json({ success: false, error: 'Invalid transfer amount.' });
  const client = await getClient();
  const session = client.startSession();

  try {
    let transaction;
    await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB_NAME || 'securepay');
      const senderUser = await db.collection('users').findOne({ email: sender_email }, { session });
      const sender = senderUser && await db.collection('accounts').findOne({ user_id: senderUser._id }, { session });
      if (!sender) throw new Error('Sender account not found.');

      const receiver = await db.collection('accounts').findOne({ account_number: receiver_account_number }, { session });
      if (!receiver) throw new Error('Receiver account not registered.');
      if (sender._id === receiver._id) throw new Error('Sender and receiver accounts must be different.');

      const trustCheck = await db.collection('transactions').findOne({
        $or: [
          { sender_account_id: sender._id, receiver_account_id: receiver._id },
          { sender_account_id: receiver._id, receiver_account_id: sender._id }
        ],
        status: 'COMPLETED'
      }, { session });
      const isTrusted = Boolean(trustCheck);
      const debit = await db.collection('accounts').updateOne(
        { _id: sender._id, balance: { $gte: transferAmount } },
        { $inc: { balance: -transferAmount } },
        { session }
      );
      if (debit.modifiedCount !== 1) throw new Error('Insufficient account balance.');
      await db.collection('accounts').updateOne({ _id: receiver._id }, { $inc: { balance: transferAmount } }, { session });
      transaction = {
        _id: createId('TXN'),
        sender_account_id: sender._id,
        receiver_account_id: receiver._id,
        amount: transferAmount,
        status: isTrusted ? 'PENDING_TRUSTED' : 'PENDING',
        created_at: new Date(),
        new_balance: Number(sender.balance) - transferAmount
      };
      await db.collection('transactions').insertOne(transaction, { session });
      transaction.is_trusted = isTrusted;
    });
    
    return res.status(200).json({ 
      success: true, 
      transaction_id: transaction._id,
      new_balance: transaction.new_balance,
      is_trusted: transaction.is_trusted
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  } finally {
    await session.endSession();
  }
};
