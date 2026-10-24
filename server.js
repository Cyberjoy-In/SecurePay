const http = require('http');
const fs = require('fs');
const path = require('path');

const apiRouter = require('./lib/api/router');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(Object.assign(new Error('Malformed JSON request body.'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  if (requestUrl.pathname.startsWith('/api/')) {
    try {
      req.query = Object.fromEntries(requestUrl.searchParams);
      req.body = await readBody(req);
      return await apiRouter(req, {
        status: statusCode => ({
          json: payload => sendJson(res, statusCode, payload),
          send: payload => { res.writeHead(statusCode); res.end(payload); }
        })
      });
    } catch (error) {
      const status = error.statusCode || 500;
      return sendJson(res, status, { error: status < 500 ? error.message : 'Internal server error.' });
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
