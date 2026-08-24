const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

module.exports = async (req, res) => {
  // Only accept POST requests
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body;

  try {
    // 1. Search the database for the user's profile AND their bank account details at the same time
    const result = await pool.query(`
      SELECT u.user_id, u.full_name, u.email, u.password_hash, a.account_number, a.balance
      FROM users u
      JOIN accounts a ON u.user_id = a.user_id
      WHERE u.email = $1
    `, [email]);

    const user = result.rows[0];

    // 2. If the user exists, check if the password matches
    if (user && await bcrypt.compare(password, user.password_hash)) {
      
      // 3. Create a temporary digital ID card (token) for this user
      const token = jwt.sign(
        { user_id: user.user_id }, 
        process.env.JWT_SECRET || 'securepay_demo_key', 
        { expiresIn: '1h' }
      );
      
      // 4. Give them the ID card AND their live account details
      return res.status(200).json({ 
        success: true, 
        token: token, 
        full_name: user.full_name,
        account_number: user.account_number,
        balance: parseFloat(user.balance) // We make sure the balance acts as a real number
      });
    } else {
      // If the email or password is wrong, block them
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
  } catch (error) {
    // If the database crashes, show the exact error
    return res.status(500).json({ error: 'Login failed: ' + error.message });
  }
};
