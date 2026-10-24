require('dotenv').config();
const { getDatabase } = require('../lib/api/_db');

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) throw new Error('Set ADMIN_EMAIL to the email of an already registered account.');

  const db = await getDatabase();
  const user = await db.collection('users').findOne({
    email: new RegExp(`^${escapeRegex(email)}$`, 'i')
  });

  if (!user) {
    throw new Error(`No registered account was found for ${email}. Register that account normally first, then run npm run bootstrap-admin.`);
  }

  const account = await db.collection('accounts').findOne({ user_id: user._id });
  if (!account) {
    throw new Error(`The user account for ${email} is incomplete because no banking account exists. Register the account normally, then retry.`);
  }

  const result = await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { role: 'admin', account_status: 'ACTIVE', admin_bootstrapped_at: new Date() } }
  );

  if (result.matchedCount !== 1) throw new Error(`The existing account for ${email} could not be promoted.`);
  console.log(`Administrator role enabled for ${email}; the existing password hash was preserved.`);
}
main().catch(error => { console.error(error.message); process.exit(1); });
