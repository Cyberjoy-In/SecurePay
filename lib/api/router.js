const handlers = new Map([
  ['approve', require('./approve')],
  ['audit', require('./audit')],
  ['admin', require('./admin')],
  ['bbps', require('./bbps')],
  ['change-password', require('./change-password')],
  ['cards', require('./cards')],
  ['portfolio', require('./portfolio')],
  ['grievance', require('./grievance')],
  ['fds', require('./fds')],
  ['invest', require('./invest')],
  ['login', require('./login')],
  ['register', require('./register')],
  ['service_request', require('./service_request')],
  ['sync', require('./sync')],
  ['transfer', require('./transfer')]
]);
const { runWithRequest } = require('./_request-context');

function endpointName(req) {
  const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  return pathname.slice('/api/'.length).replace(/^\/+|\/+$/g, '').split('/')[0];
}

async function router(req, res) {
  const name = endpointName(req);
  const handler = handlers.get(name);
  if (!handler) return res.status(404).json({ error: 'API endpoint not found' });

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  req.query = { ...(req.query || {}), ...Object.fromEntries(requestUrl.searchParams) };
  if (typeof req.body === 'string') {
    try { req.body = req.body ? JSON.parse(req.body) : {}; }
    catch { return res.status(400).json({ error: 'Malformed JSON request body.' }); }
  }
  if (req.body == null) req.body = {};
  return runWithRequest(req, () => handler(req, res));
}

module.exports = router;
