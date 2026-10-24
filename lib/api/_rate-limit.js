const buckets = new Map();

function requestAddress(req) {
  if (process.env.TRUST_PROXY === 'true') return String(req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || '').split(',')[0].trim();
  return String(req.socket?.remoteAddress || 'unknown');
}

function allowRequest(req, scope, limit = 20, windowMs = 60_000) {
  const now = Date.now();
  const key = `${scope}:${requestAddress(req)}`;
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

module.exports = { allowRequest };
