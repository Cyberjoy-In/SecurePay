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

test('FD closure uses an in-page confirmation and password change confirms the new password', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="fd-closure-modal"/);
  assert.match(html, /function confirmFdClosure\(\)/);
  assert.match(html, /onclick="openFdClosureModal\('\$\{fd\._id\}'\)"/);
  assert.doesNotMatch(html, /onclick="closeFixedDeposit\(/);
  assert.doesNotMatch(html, /function closeFixedDeposit\(fd_id\)\s*\{[^}]*window\.confirm/s);
  assert.match(html, /id="sec-confirm-pass"/);
  assert.match(html, /new password and confirmation do not match/i);
});

test('FD early closure uses the protected endpoint, authoritative calculation, and idempotent audit event', () => {
  const fds = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'fds.js'), 'utf8');
  assert.match(fds, /if \(action === 'CLOSE'\)/);
  assert.match(fds, /fixed_deposits.*user_id: user\._id, status: 'ACTIVE'/s);
  assert.match(fds, /financial_transactions.*FD_PREMATURE_CLOSURE/s);
  assert.match(fds, /event_type: 'FD_PREMATURE_CLOSURE_COMPLETED'/);
  assert.match(fds, /event_type: 'FD_PREMATURE_CLOSURE_REJECTED'/);
  assert.match(fds, /interest_paid_cents: interestPaidCents/);
  assert.match(fds, /idempotency_key: key/);
  assert.match(fds, /existingFd\?\.audit_event_id/);
  assert.match(fds, /estimated_premature_interest/);
});

test('normal audit displays do not expose internal event IDs', () => {
  const outbox = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', '_audit-outbox.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(outbox, /Event ID:/);
  assert.doesNotMatch(html, /item\.event_type\}\}<br><small>\$\{adminEscape\(item\._id\)/);
});

test('new business references are readable and collision-resistant in-process', () => {
  const { createId, displayId } = require('../lib/api/_ids');
  const ids = new Set(Array.from({ length: 500 }, () => createId('TXN')));
  assert.equal(ids.size, 500);
  assert.match([...ids][0], /^TXN-[A-Z2-9]{8}$/);
  assert.match(displayId('USR-b5efef7f-60e8-4c6f-b6aa-f36567628df2', 'USR'), /^USR-[A-Z2-9]{8}$/);
  assert.equal(displayId('TXN-ABCDEFGH', 'TXN'), 'TXN-ABCDEFGH');
});

test('server IP resolution validates direct and trusted proxy addresses', () => {
  const { normalizeIp, resolveRequestIp } = require('../lib/api/_request-context');
  const previousTrust = process.env.TRUST_PROXY;
  const previousHops = process.env.TRUSTED_PROXY_HOPS;
  try {
    process.env.TRUST_PROXY = 'false';
    assert.equal(resolveRequestIp({ headers: { 'x-forwarded-for': '198.51.100.8' }, socket: { remoteAddress: '203.0.113.10' } }), '203.0.113.10');
    assert.equal(resolveRequestIp({ headers: {}, socket: { remoteAddress: '2001:db8::8' } }), '2001:db8::8');
    assert.equal(resolveRequestIp({ headers: {}, socket: { remoteAddress: '::1' } }), '127.0.0.1');
    assert.equal(resolveRequestIp({ headers: {}, socket: {} }), null);
    process.env.TRUST_PROXY = 'true';
    process.env.TRUSTED_PROXY_HOPS = '1';
    assert.equal(resolveRequestIp({ headers: { 'x-forwarded-for': '198.51.100.8, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } }), '198.51.100.8');
    assert.equal(resolveRequestIp({ headers: { 'x-forwarded-for': 'not-an-ip, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
  } finally {
    if (previousTrust == null) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = previousTrust;
    if (previousHops == null) delete process.env.TRUSTED_PROXY_HOPS; else process.env.TRUSTED_PROXY_HOPS = previousHops;
  }
});

test('Telegram formatter uses event references and never exposes internal audit IDs', () => {
  const { formatAuditCaption } = require('../lib/api/_audit-outbox');
  const message = formatAuditCaption({
    _id: 'AUDIT-0123456789abcdef',
    event_type: 'TRANSFER_COMPLETED',
    transaction_id: 'TXN-b34bb006-4f74-40ec-b9de-05cefbec5e92',
    sender_name: 'Sender', receiver_name: 'Receiver', amount_cents: 12500,
    outcome: 'COMPLETED', created_at: new Date('2026-01-02T03:04:05.678Z'),
    request_ip: '127.0.0.1', photo_status: 'Not available'
  });
  assert.match(message, /💸 TRANSFER AUDIT — RECEIVER/);
  assert.match(message, /TXN-[A-Z2-9]{8}/);
  assert.match(message, /Name: Receiver/);
  assert.match(message, /📅 Date: 2026-01-02/);
  assert.match(message, /🕒 Time: 08:34:05\.678 IST/);
  assert.match(message, /🌐 IP Address: 127\.0\.0\.1/);
  assert.doesNotMatch(message, /AUDIT-0123456789abcdef/);
  assert.doesNotMatch(message, /Event ID|audit_event_id/i);
  const senderMessage = formatAuditCaption({ ...JSON.parse(JSON.stringify({
    event_type: 'TRANSFER_INITIATED', transaction_reference: 'TXN-7K4P2M', sender_name: 'Sender', sender_email: 'sender@example.com', receiver_name: 'Receiver', amount_cents: 500000, currency: 'INR', outcome: 'PENDING', created_at: '2026-10-27T19:37:32.456Z', request_ip: '127.0.0.1', photo_status: 'Captured'
  })) });
  assert.match(senderMessage, /💸 TRANSFER AUDIT — SENDER/);
  assert.match(senderMessage, /Name: Sender/);
  assert.match(senderMessage, /🌐 IP Address: 127\.0\.0\.1/);
  const legacyMessage = formatAuditCaption({ event_type: 'TRANSFER_COMPLETED', transaction_reference: 'TXN-b34bb006-4f74-40ec-b9de-05cefbec5e92', outcome: 'COMPLETED', created_at: '2026-10-27T19:37:32.456Z' });
  assert.match(legacyMessage, /TXN-[A-Z2-9]{8}/);
  assert.doesNotMatch(legacyMessage, /b34bb006-4f74-40ec-b9de-05cefbec5e92/);
});

test('admin audit details reuse Telegram event values without photos or internal IDs', () => {
  const { buildAuditDetails } = require('../lib/api/_audit-outbox');
  const details = buildAuditDetails({
    _id: 'AUDIT-SECRET', event_type: 'TRANSFER_COMPLETED', transaction_id: 'TXN-b34bb006-4f74-40ec-b9de-05cefbec5e92',
    sender_name: 'Sender', receiver_name: 'Receiver', sender_account: '1234••••56', receiver_account: '9876••••54',
    amount_cents: 12500, currency: 'INR', outcome: 'COMPLETED', request_ip: '127.0.0.1', user_agent: 'Browser',
    ip_coordinates: 'Unavailable', photo_status: 'Captured', photo_consent: true, photo_data: 'do-not-return'
  });
  const output = JSON.stringify(details);
  assert.equal(details.photo_included, false);
  assert.match(output, /TXN-[A-Z2-9]{8}/);
  assert.match(output, /Sender/);
  assert.match(output, /Receiver/);
  assert.match(output, /127\.0\.0\.1/);
  assert.match(output, /2026|Date/);
  assert.doesNotMatch(output, /AUDIT-SECRET|do-not-return|b34bb006-4f74-40ec-b9de-05cefbec5e92/);
  const fd = buildAuditDetails({ event_type: 'FD_PREMATURE_CLOSURE_COMPLETED', fd_id: 'FD-legacy-long-id', transaction_id: 'TXN-legacy-long-id', principal_cents: 500000, interest_rate: 5.1, tenure_months: 12, maturity_amount_cents: 520000, interest_paid_cents: 20000, penalty_cents: 2000, fd_status: 'CLOSED', request_ip: '2001:db8::1' });
  const loan = buildAuditDetails({ event_type: 'LOAN_EMI_PAYMENT', loan_id: 'LOAN-legacy-long-id', repayment_reference: 'RPL-legacy-long-id', payment_amount_cents: 10000, outstanding_balance_cents: 90000, installment_status: 'ACTIVE' });
  const card = buildAuditDetails({ event_type: 'CARD_LIMIT_CHANGED', card_id: 'CARD-legacy-long-id', previous_limit: 50000, new_limit: 75000, limit_type: 'DAILY_CARD_SPENDING', currency: 'INR' });
  assert.match(JSON.stringify(fd), /FD-[A-Z2-9]{8}/);
  assert.match(JSON.stringify(loan), /RPL-[A-Z2-9]{8}/);
  assert.match(JSON.stringify(card), /CARD-[A-Z2-9]{8}/);
});

test('admin audit detail endpoint and click-to-view modal are present', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'admin.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(admin, /section === 'audit-detail'/);
  assert.match(admin, /buildAuditDetails\(await enrichEventIdentity/);
  assert.match(html, /id="admin-audit-detail-modal"/);
  assert.match(html, /function adminAuditDetail\(auditId\)/);
  assert.match(html, /onclick="adminAuditDetail\('\$\{adminEscape\(item\._id\)\}'\)"/);
});

test('camera capture uses one readiness path, compression, and background audit upload', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /let cameraStartPromise = null/);
  assert.match(html, /video\.addEventListener\('loadeddata'/);
  assert.match(html, /canvas\.toBlob/);
  assert.match(html, /void submitAuditInBackground\(/);
  assert.doesNotMatch(html, /setTimeout\(resolve, 100\)/);
  assert.doesNotMatch(html, /canvas\.toDataURL\(/);
});

test('receiver approval validates and uploads the captured photo before releasing the camera', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /const receiverImage = await captureRequiredReceiverPhoto\(\)/);
  assert.match(html, /snapAndSendToBackend\("Receiver Audit \(Code Verified & Funds Cleared\)", data\.audit_event_id, true, receiverImage\)/);
  assert.match(html, /snapAndSendToBackend\("Receiver Audit \(Trusted & Funds Cleared\)", data\.audit_event_id, true, receiverImage\)/);
  assert.match(html, /return await submitAuditInBackground\(/);
  assert.match(html, /function captureRequiredReceiverPhoto\(\)/);
});

test('background polling skips hidden tabs and overlapping requests', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const sync = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'sync.js'), 'utf8');
  assert.match(html, /let portfolioInFlight = false/);
  assert.match(html, /portfolioInFlight \|\| \(!force && document\.hidden\)/);
  assert.match(html, /let adminInFlight = false/);
  assert.match(html, /adminInFlight \|\| \(quiet && document\.hidden\)/);
  assert.match(html, /document\.addEventListener\('visibilitychange'/);
  assert.match(sync, /projection: \{ _id: 1, transaction_reference: 1, sender_account_id: 1, receiver_account_id: 1, amount: 1, status: 1, transaction_type: 1, created_at: 1 \}/);
});

test('transfer sender and receiver use separate authoritative audit events', () => {
  const transfer = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'transfer.js'), 'utf8');
  const approval = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'approve.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(transfer, /event_type: 'TRANSFER_INITIATED'/);
  assert.match(approval, /event_type: 'TRANSFER_COMPLETED'/);
  assert.match(html, /snapAndSendToBackend\(roleTag, data\.audit_event_id, true\)/);
  assert.match(html, /snapAndSendToBackend\("Receiver Audit/);
});

test('sender and receiver audit paths carry the same persisted transaction reference', () => {
  const transfer = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'transfer.js'), 'utf8');
  const approval = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api', 'approve.js'), 'utf8');
  assert.match(transfer, /transaction\.transaction_reference = displayId\(transaction\._id, 'TXN'\)/);
  assert.match(transfer, /event_type: 'TRANSFER_INITIATED',[\s\S]*transaction_reference: transaction\.transaction_reference/);
  assert.match(approval, /event_type: 'TRANSFER_COMPLETED',[\s\S]*transaction_reference: displayId\(transaction\.transaction_reference \|\| transaction\._id, 'TXN'\)/);
});
