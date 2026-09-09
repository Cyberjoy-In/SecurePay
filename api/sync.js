const { getDatabase } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email } = req.body;

  try {
    const db = await getDatabase();
    const user = await db.collection('users').findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const account = await db.collection('accounts').findOne({ user_id: user._id });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const transactions = await db.collection('transactions')
      .find({ $or: [{ sender_account_id: account._id }, { receiver_account_id: account._id }] })
      .sort({ created_at: -1 })
      .limit(15)
      .toArray();
    const transactionRows = transactions.map(({ _id, ...transaction }) => ({
      ...transaction,
      transaction_id: _id
    }));

    return res.status(200).json({ success: true, account_id: account._id, balance: Number(account.balance), transactions: transactionRows });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
