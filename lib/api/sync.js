const { getDatabase } = require('./_db');
const { verifyRequest } = require('./_auth');
const { displayId } = require('./_ids');

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
      .find({ $or: [{ sender_account_id: account._id }, { receiver_account_id: account._id }] }, { projection: { _id: 1, transaction_reference: 1, sender_account_id: 1, receiver_account_id: 1, amount: 1, status: 1, transaction_type: 1, created_at: 1 } })
      .sort({ created_at: -1 })
      .limit(15)
      .toArray();
    const transactionRows = transactions.map(transaction => ({
      transaction_id: transaction._id,
      transaction_reference: displayId(transaction.transaction_reference || transaction._id, 'TXN'),
      sender_account_id: transaction.sender_account_id,
      receiver_account_id: transaction.receiver_account_id,
      amount: Number(transaction.amount),
      status: transaction.status,
      transaction_type: transaction.transaction_type,
      created_at: transaction.created_at
    }));

    return res.status(200).json({ success: true, account_id: account._id, account_reference: displayId(account._id, 'ACCT'), balance: Number(account.balance), transactions: transactionRows });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to synchronize account data.' });
  }
};
