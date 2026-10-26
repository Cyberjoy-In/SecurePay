const { AsyncLocalStorage } = require('node:async_hooks');
const net = require('node:net');

const requestStorage = new AsyncLocalStorage();

function normalizeIp(value) {
  let candidate = String(value || '').trim();
  if (!candidate) return null;
  if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1);
  const zoneIndex = candidate.indexOf('%');
  if (zoneIndex !== -1) candidate = candidate.slice(0, zoneIndex);
  if (net.isIP(candidate) === 0) return null;
  if (candidate.startsWith('::ffff:') && net.isIP(candidate.slice(7)) === 4) return candidate.slice(7);
  if (candidate === '::1') return '127.0.0.1';
  return candidate;
}

function forwardedChain(req) {
  const value = req?.headers?.['x-forwarded-for'];
  if (!value) return [];
  const values = String(value).split(',').map(item => normalizeIp(item));
  return values.length && values.every(Boolean) ? values : null;
}

function resolveRequestIp(req = currentRequest()) {
  const socketIp = normalizeIp(req?.socket?.remoteAddress || req?.ip);
  if (String(process.env.TRUST_PROXY || '').toLowerCase() !== 'true') return socketIp;

  const chain = forwardedChain(req);
  if (chain === null) return socketIp;
  if (chain.length) {
    const trustedHops = Math.max(1, Math.min(10, Number(process.env.TRUSTED_PROXY_HOPS || 1)));
    return chain[Math.max(0, chain.length - trustedHops - 1)] || socketIp;
  }
  return normalizeIp(req?.headers?.['x-real-ip']) || socketIp;
}

function runWithRequest(req, callback) {
  return requestStorage.run(req, callback);
}

function currentRequest() {
  return requestStorage.getStore();
}

module.exports = { normalizeIp, resolveRequestIp, runWithRequest, currentRequest };
