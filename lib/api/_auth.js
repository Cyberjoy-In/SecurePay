const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');

function authFailure(message, statusCode = 401) {
  throw Object.assign(new Error(message), { statusCode });
}

function verifyRequest(req) {
  const header = String(req.headers?.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) authFailure('Authentication is required.');
  try {
    const options = {};
    if (process.env.JWT_ISSUER) options.issuer = process.env.JWT_ISSUER;
    if (process.env.JWT_AUDIENCE) options.audience = process.env.JWT_AUDIENCE;
    return jwt.verify(token, getRequiredEnv('JWT_SECRET'), options);
  } catch {
    authFailure('Your session has expired or is invalid.');
  }
}

async function requireUser(req, db, options = {}) {
  const identity = verifyRequest(req);
  const user = await db.collection('users').findOne({ _id: identity.user_id });
  if (!user) authFailure('Authenticated user could not be verified.');
  if (Number(identity.token_version || 0) !== Number(user.token_version || 0)) authFailure('Your session has been revoked.');
  if (!options.allowSuspended && user.account_status === 'SUSPENDED') authFailure('This account is suspended.', 403);
  if (options.roles) {
    const roles = new Set(options.roles.map(role => String(role).toLowerCase()));
    if (!roles.has(String(user.role || 'customer').toLowerCase())) authFailure('You are not authorized for this action.', 403);
  }
  return { identity, user };
}

module.exports = { authFailure, verifyRequest, requireUser };
