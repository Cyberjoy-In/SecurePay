const http = require('http');
const fs = require('fs');
const path = require('path');

const apiHandlers = new Map([
  ['approve', require('./api/approve')],
  ['audit', require('./api/audit')],
  ['bbps', require('./api/bbps')],
  ['grievance', require('./api/grievance')],
  ['invest', require('./api/invest')],
  ['login', require('./api/login')],
  ['register', require('./api/register')],
  ['service_request', require('./api/service_request')],
  ['sync', require('./api/sync')],
  ['transfer', require('./api/transfer')]
]);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname.startsWith('/api/')) {
    const handler = apiHandlers.get(requestUrl.pathname.slice(5));
    if (!handler) return sendJson(res, 404, { error: 'API endpoint not found' });

    try {
      req.query = Object.fromEntries(requestUrl.searchParams);
      req.body = await readBody(req);
      return await handler(req, {
        status: statusCode => ({
          json: payload => sendJson(res, statusCode, payload),
          send: payload => { res.writeHead(statusCode); res.end(payload); }
        })
      });
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  const requestedPath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const filePath = path.resolve(__dirname, `.${requestedPath}`);
  if (!filePath.startsWith(path.resolve(__dirname)) || !fs.existsSync(filePath)) {
    return sendJson(res, 404, { error: 'File not found' });
  }

  const contentType = filePath.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`SecurePay running at http://localhost:${port}`);
});