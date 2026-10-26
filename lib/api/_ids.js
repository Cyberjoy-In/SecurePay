const crypto = require('crypto');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createId(prefix) {
  const bytes = crypto.randomBytes(8);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `${prefix}-${suffix}`;
}

function displayId(value, prefix) {
  const raw = String(value || '');
  if (!raw) return null;
  const detectedPrefix = raw.includes('-') ? raw.slice(0, raw.indexOf('-')).toUpperCase() : String(prefix || 'REF').toUpperCase();
  if (/^[A-Z]+-[A-Z2-9]{8}$/.test(raw)) return raw;
  const digest = crypto.createHash('sha256').update(raw).digest();
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += alphabet[digest[i] % alphabet.length];
  return `${detectedPrefix}-${suffix}`;
}

module.exports = { createId, displayId };
