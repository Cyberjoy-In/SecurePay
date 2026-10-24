const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const router = require('../lib/api/router');

async function request(url, method = 'GET', body = {}) {
  let statusCode = 200;
  let payload;
  const response = {
    status(code) { statusCode = code; return response; },
    json(value) { payload = value; return response; },
    send(value) { payload = value; return response; }
  };
  await router({ url, method, headers: {}, body }, response);
  return { statusCode, payload };
}

for (const endpoint of ['/api/sync', '/api/grievance', '/api/service_request', '/api/audit', '/api/admin']) {
  test(`rejects unauthenticated ${endpoint}`, async () => {
    const result = await request(endpoint, endpoint === '/api/grievance' ? 'GET' : 'POST', {});
    assert.equal(result.statusCode, 401);
  });
}

test('rejects unauthenticated simulated bill payment', async () => {
  const result = await request('/api/bbps', 'POST', { type: 'mobile', accountNumber: '9000000000', amount: 10, idempotency_key: 'TEST-1' });
  assert.equal(result.statusCode, 401);
});

test('only one Vercel API function entry point remains', () => {
  const apiFiles = fs.readdirSync(path.join(__dirname, '..', 'api')).filter(name => name.endsWith('.js'));
  assert.deepEqual(apiFiles, ['[...path].js']);
});

test('production frontend does not hard-code a localhost API origin', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /http:\/\/localhost:3000/);
  assert.match(html, /window\.SECUREPAY_API_ORIGIN/);
});
