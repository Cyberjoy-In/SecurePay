const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body;

  try {
    // 1. Get user's account details
    const userRes = await pool.query(`
      SELECT a.account_id, a.balance 
      FROM accounts a
      JOIN users u ON a.user_id = u.user_id
      WHERE u.email = $1
    `, [email]);

    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    // 2. Fetch all transactions where this user is the sender OR receiver
    const txnRes = await pool.query(`
      SELECT transaction_id, sender_account_id, receiver_account_id, amount, status, created_at 
      FROM transactions
      WHERE sender_account_id = $1 OR receiver_account_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [user.account_id]);

    return res.status(200).json({
      success: true,
      account_id: user.account_id,
      balance: parseFloat(user.balance),
      transactions: txnRes.rows
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
