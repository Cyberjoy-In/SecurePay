const { Pool } = require('pg');
const bcrypt = require('bcrypt');

// This acts as the bridge to your Vercel database
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

module.exports = async (req, res) => {
  // Only accept data that is being sent to us
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Grab the name, email, and password the user typed in
  const { full_name, email, password } = req.body;

  try {
    // 1. Scramble the password using our bcrypt tool
    const hashedPassword = await bcrypt.hash(password, 10);

    // 2. Save the new user to the "users" table
    const result = await pool.query(
      'INSERT INTO users (full_name, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id',
      [full_name, email, hashedPassword]
    );

    // 3. Create a bank account for them with a default balance of ₹10,000
    const userId = result.rows[0].user_id;
    const accountNumber = 'ACCT-' + Math.floor(Math.random() * 1000000000); 

    await pool.query(
      'INSERT INTO accounts (user_id, account_number) VALUES ($1, $2)',
      [userId, accountNumber]
    );

    // Tell the website it worked!
    return res.status(200).json({ success: true, message: 'Account created successfully!' });
    
  } catch (error) {
    return res.status(500).json({ error: 'Email might already exist.' });
  }
};
