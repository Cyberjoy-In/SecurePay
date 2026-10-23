const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');
const { getClient } = require('./_db');
const { createId } = require('./_ids');

function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw Object.assign(new Error('Your session has expired. Please sign in again.'), { statusCode: 401 });
  try { return jwt.verify(token, getRequiredEnv('JWT_SECRET')); }
  catch { throw Object.assign(new Error('Your session has expired. Please sign in again.'), { statusCode: 401 }); }
}

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  let payload;
  try { payload = authenticate(req); } catch (error) { return res.status(error.statusCode || 401).json({ error: error.message }); }

  const client = await getClient();
  const session = client.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const db = client.db(process.env.MONGODB_DB_NAME || 'securepay');
      const user = await db.collection('users').findOne({ _id: payload.user_id }, { session });
      const account = user && await db.collection('accounts').findOne({ user_id: user._id }, { session });
      if (!user || !account) throw Object.assign(new Error('Account not found.'), { statusCode: 404 });

      if (req.method === 'GET') {
        const sanctionBefore = new Date(Date.now() - 4500);
        await db.collection('loans').updateMany(
          { user_id: user._id, status: 'UNDER_REVIEW', created_at: { $lte: sanctionBefore } },
          { $set: { status: 'SANCTIONED', sanctioned_at: new Date() } },
          { session }
        );
        const [cards, loans, deposits] = await Promise.all([
          db.collection('cards').find({ user_id: user._id }, { session }).sort({ created_at: -1 }).toArray(),
          db.collection('loans').find({ user_id: user._id }, { session }).sort({ created_at: -1 }).toArray(),
          db.collection('fixed_deposits').find({ user_id: user._id }, { session }).sort({ created_at: -1 }).toArray()
        ]);
        return { account, cards, loans, deposits };
      }

      const body = req.body || {};
      const requestedAction = String(body.action || '').toUpperCase();
      const actionAliases = {
        CARD_APPLICATION: 'APPLY_CARD',
        DAILY_LIMIT_UPDATE: 'SET_LIMIT',
        LOAN_APPLICATION: 'APPLY_LOAN',
        FD_OPENED: 'OPEN_FD',
        FD_CLOSED: 'CLOSE_FD'
      };
      const action = actionAliases[requestedAction] || requestedAction;
      const now = new Date();
      if (action === 'APPLY_CARD') {
        const card = { _id: createId('CARD'), user_id: user._id, type: body.card_type || 'SecurePay Platinum', last4: String(Math.floor(1000 + Math.random() * 9000)), status: 'PENDING_REVIEW', daily_limit: 100000, created_at: now };
        await db.collection('cards').insertOne(card, { session });
        return { action, card };
      }
      if (action === 'SET_LIMIT') {
        const limit = Number(body.limit);
        if (!Number.isFinite(limit) || limit < 1000 || limit > 1000000) throw new Error('Set a limit between ₹1,000 and ₹10,00,000.');
        await db.collection('accounts').updateOne({ _id: account._id }, { $set: { daily_limit: limit } }, { session });
        return { action, limit };
      }
      if (action === 'APPLY_LOAN') {
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount < 10000 || amount > 500000) throw new Error('Loan amount must be between ₹10,000 and ₹5,00,000.');
        const interestRate = 12;
        const termMonths = Number(body.term_months) || 12;
        const monthlyRate = interestRate / 100 / 12;
        const emi = monthlyRate ? amount * monthlyRate * Math.pow(1 + monthlyRate, termMonths) / (Math.pow(1 + monthlyRate, termMonths) - 1) : amount / termMonths;
        const monthlyEmi = Math.round(emi * 100) / 100;
        const totalPayable = Math.round(monthlyEmi * termMonths * 100) / 100;
        const interestAmount = Math.round((totalPayable - amount) * 100) / 100;
        const loan = { _id: createId('LOAN'), user_id: user._id, amount, principal: amount, interest_rate: interestRate, interest_amount: interestAmount, monthly_emi: monthlyEmi, total_payable: totalPayable, outstanding: totalPayable, term_months: termMonths, purpose: String(body.purpose || 'Personal'), status: 'UNDER_REVIEW', created_at: now };
        await db.collection('loans').insertOne(loan, { session });
        return { action, loan };
      }
      if (action === 'LOAN_PAYMENT') {
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid loan payment.');
        const loan = await db.collection('loans').findOne({ _id: body.loan_id, user_id: user._id, status: { $in: ['SANCTIONED', 'ACTIVE'] } }, { session });
        if (!loan) throw new Error('Loan not found.');
        if (Number(account.balance) < amount) throw new Error('Insufficient account balance.');
        const payment = Math.min(amount, Number(loan.outstanding));
        const outstanding = Math.max(0, Number(loan.outstanding) - payment);
        await db.collection('accounts').updateOne({ _id: account._id }, { $inc: { balance: -payment } }, { session });
        await db.collection('loans').updateOne({ _id: loan._id }, { $set: { outstanding, status: outstanding === 0 ? 'PAID' : 'ACTIVE', updated_at: now } }, { session });
        const transaction = { _id: createId('TXN'), user_id: user._id, account_id: account._id, type: 'LOAN_PAYMENT', amount: payment, status: 'COMPLETED', created_at: now };
        await db.collection('financial_transactions').insertOne(transaction, { session });
        return { action, amount: payment, reference: transaction._id, new_balance: Number(account.balance) - payment };
      }
      if (action === 'OPEN_FD') {
        const amount = Number(body.amount);
        const tenure = Number(body.tenure_months) || 12;
        if (!Number.isFinite(amount) || amount < 5000) throw new Error('Minimum fixed deposit amount is ₹5,000.');
        if (Number(account.balance) < amount) throw new Error('Insufficient account balance.');
        const deposit = { _id: createId('FD'), user_id: user._id, principal: amount, interest_rate: 7.1, tenure_months: tenure, maturity_amount: Math.round(amount * (1 + 0.071 * tenure / 12)), status: 'ACTIVE', created_at: now };
        await db.collection('accounts').updateOne({ _id: account._id }, { $inc: { balance: -amount } }, { session });
        await db.collection('fixed_deposits').insertOne(deposit, { session });
        const transaction = { _id: createId('TXN'), user_id: user._id, account_id: account._id, type: 'FD_OPENED', amount, status: 'COMPLETED', created_at: now };
        await db.collection('financial_transactions').insertOne(transaction, { session });
        return { action, deposit, reference: transaction._id, new_balance: Number(account.balance) - amount };
      }
      if (action === 'CLOSE_FD') {
        const deposit = await db.collection('fixed_deposits').findOne({ _id: body.deposit_id, user_id: user._id, status: 'ACTIVE' }, { session });
        if (!deposit) throw new Error('Fixed deposit not found or already closed.');
        await db.collection('fixed_deposits').updateOne({ _id: deposit._id }, { $set: { status: 'CLOSED', closed_at: now } }, { session });
        await db.collection('accounts').updateOne({ _id: account._id }, { $inc: { balance: deposit.maturity_amount } }, { session });
        const transaction = { _id: createId('TXN'), user_id: user._id, account_id: account._id, type: 'FD_CLOSED', amount: deposit.maturity_amount, status: 'COMPLETED', created_at: now };
        await db.collection('financial_transactions').insertOne(transaction, { session });
        return { action, amount: deposit.maturity_amount, reference: transaction._id, new_balance: Number(account.balance) + Number(deposit.maturity_amount) };
      }
      throw new Error('Unsupported financial action.');
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message });
  } finally {
    await session.endSession();
  }
};
