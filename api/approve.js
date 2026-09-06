const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transaction_id } = req.body;

  try {
    // 🚨 Updates the status to COMPLETED after the receiver passes the camera audit 🚨
    await pool.query(`
      UPDATE transactions 
      SET status = 'COMPLETED' 
      WHERE transaction_id = $1
    `, [transaction_id]);

    return res.status(200).json({ success: true, message: 'Transfer settled.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
