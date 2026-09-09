const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');

const pool = new Pool({ connectionString: getRequiredEnv('POSTGRES_URL') });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email, password } = req.body;

  try {
    const result = await pool.query(`
      SELECT u.user_id, u.full_name, u.email, u.password_hash, a.account_number, a.balance
      FROM users u
      JOIN accounts a ON u.user_id = a.user_id
      WHERE u.email = $1
    `, [email]);

    const user = result.rows[0];

    if (user && await bcrypt.compare(password, user.password_hash)) {
      const token = jwt.sign({ user_id: user.user_id }, getRequiredEnv('JWT_SECRET'), { expiresIn: '1h' });
      return res.status(200).json({ 
        success: true, 
        token: token, 
        full_name: user.full_name,
        account_number: user.account_number,
        balance: parseFloat(user.balance)
      });
    } else {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Login failed: ' + error.message });
  }
};
