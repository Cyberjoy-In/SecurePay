const { getDatabase } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { transaction_id } = req.body;

  try {
    const db = await getDatabase();
    const result = await db.collection('transactions').updateOne({ _id: transaction_id }, { $set: { status: 'COMPLETED', completed_at: new Date() } });
    if (result.matchedCount !== 1) return res.status(404).json({ error: 'Transaction not found.' });
    return res.status(200).json({ success: true, message: 'Transfer settled.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
