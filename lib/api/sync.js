const { getDatabase } = require('./_db');
const { verifyRequest } = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const identity = verifyRequest(req);
    const db = await getDatabase();
    const user = await db.collection('users').findOne({ _id: identity.user_id });
    if (!user || Number(identity.token_version || 0) !== Number(user.token_version || 0)) return res.status(401).json({ error: 'Your session is invalid or has been revoked.' });
    if (user.account_status === 'SUSPENDED') return res.status(403).json({ error: 'This account is suspended.' });
    const account = await db.collection('accounts').findOne({ user_id: user._id });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const transactions = await db.collection('transactions')
      .find({ $or: [{ sender_account_id: account._id }, { receiver_account_id: account._id }] })
      .sort({ created_at: -1 })
      .limit(15)
      .toArray();
    const transactionRows = transactions.map(transaction => ({
      transaction_id: transaction._id,
      sender_account_id: transaction.sender_account_id,
      receiver_account_id: transaction.receiver_account_id,
      amount: Number(transaction.amount),
      status: transaction.status,
      transaction_type: transaction.transaction_type,
      created_at: transaction.created_at
    }));

    return res.status(200).json({ success: true, account_id: account._id, balance: Number(account.balance), transactions: transactionRows });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to synchronize account data.' });
  }
};
