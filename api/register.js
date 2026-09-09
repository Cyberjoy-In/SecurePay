const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { getRequiredEnv } = require('./_config');

const pool = new Pool({ connectionString: getRequiredEnv('POSTGRES_URL') });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { full_name, email, password } = req.body;

  // Strict Backend Validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const passRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\W).{6,}$/;

  if (!full_name || full_name.trim().length < 3) return res.status(400).json({ error: 'Full legal name is required.' });
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email address format.' });
  if (!passRegex.test(password)) return res.status(400).json({ error: 'Password must be at least 6 characters and include uppercase, lowercase, and a special symbol.' });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (full_name, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id',
      [full_name, email, hashedPassword]
    );

    const userId = result.rows[0].user_id;
    const accountNumber = 'ACCT-' + Math.floor(Math.random() * 1000000000); 

    await pool.query(
      'INSERT INTO accounts (user_id, account_number, balance) VALUES ($1, $2, $3)',
      [userId, accountNumber, 10000.00]
    );

    return res.status(200).json({ success: true, message: 'Account created successfully!' });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'This email address is already registered.' });
    return res.status(500).json({ error: error.message });
  }
};
