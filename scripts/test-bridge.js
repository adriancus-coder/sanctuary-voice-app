// SV-BRIDGE tests. (1) lib/bridge unit tests. (2) integration: boot the server,
// seed an owner, generate a connection code, exchange it for a token, check status,
// revoke. No socket here (see the /bridge namespace tests). Exit 0/1.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const accounts = require('../lib/accounts');
const { createBridge } = require('../lib/bridge');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.error('FAIL  ' + name + '\n      ' + (e && e.message)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function getCookie(r) { const sc = r.headers.get('set-cookie') || ''; const m = sc.match(/sv_sid=([^;]+)/); return m ? 'sv_sid=' + m[1] : ''; }

async function unit() {
  await test('createCode: 7 chars, unambiguous alphabet', () => {
    const b = createBridge({ db: {}, saveDb: () => {} });
    const { code } = b.createCode('e1');
    assert.ok(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{7}$/.test(code), 'code=' + code);
  });
  await test('exchange: valid code -> token + bridge; code is single-use', () => {
    const db = {}; const b = createBridge({ db, saveDb: () => {} });
    const { code } = b.createCode('e1');
    const r = b.exchange(code);
    assert.ok(r.token && r.bridge, 'got token+bridge');
    assert.strictEqual(r.bridge.svEventId, 'e1');
    assert.notStrictEqual(r.bridge.tokenHash, r.token, 'token hashed at rest');
    assert.strictEqual(b.exchange(code).error, 'invalid_code', 'code consumed');
  });
  await test('exchange: invalid + expired codes rejected', () => {
    const b = createBridge({ db: {}, saveDb: () => {}, codeTtlMs: 1 });
    assert.strictEqual(b.exchange('NOPE').error, 'invalid_code');
    const { code } = b.createCode('e1');
    return sleep(5).then(() => assert.strictEqual(b.exchange(code).error, 'code_expired'));
  });
  await test('findByToken / isActive / revokeByToken', () => {
    const db = {}; const b = createBridge({ db, saveDb: () => {} });
    const { code } = b.createCode('e2');
    const { token, bridge } = b.exchange(code);
    assert.strictEqual(b.findByToken(token).id, bridge.id);
    assert.ok(b.isActive(bridge));
    assert.strictEqual(b.revokeByToken(token), true);
    assert.ok(!b.isActive(b.findByToken(token)), 'revoked -> inactive');
    assert.strictEqual(b.revokeByToken(token), false, 'double revoke no-op');
  });
  await test('one active bridge per event: new exchange supersedes old', () => {
    const db = {}; const b = createBridge({ db, saveDb: () => {} });
    const t1 = b.exchange(b.createCode('e3').code).token;
    const t2 = b.exchange(b.createCode('e3').code).token;
    assert.ok(!b.isActive(b.findByToken(t1)), 'old superseded');
    assert.ok(b.isActive(b.findByToken(t2)), 'new active');
    assert.strictEqual(b.findActiveForEvent('e3').tokenHash, b.findByToken(t2).tokenHash);
  });
  await test('expired token is inactive', () => {
    const b = createBridge({ db: {}, saveDb: () => {}, tokenTtlHours: -1 });
    const { token } = b.exchange(b.createCode('e4').code);
    assert.ok(!b.isActive(b.findByToken(token)), 'expired token inactive');
  });
}

async function integration() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-bridge-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-bridge-log-'));
  const env = { ...process.env, DATA_DIR: dataDir, LOG_DIR: logDir, MASTER_ADMIN_PIN: 'acc', ADMIN_SESSION_SECRET: 'z'.repeat(40), OPENAI_API_KEY: '' };
  const serverPath = path.join(__dirname, '..', 'server.js');
  let port = await freePort();
  let srv = spawn(process.execPath, [serverPath], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up */ } await sleep(300); }
  // seed an owner into the store, then reboot to load it
  srv.kill('SIGTERM'); await sleep(700);
  const dbFile = path.join(dataDir, 'sessions.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  db.users = [{ id: 'o', email: 'o@c.org', name: 'O', password_hash: accounts.hashPassword('parola-lunga-1'), role: 'owner', active: true, must_change_password: false, created_at: new Date().toISOString(), last_login_at: null }];
  db.authSessions = [];
  db.accountsSetupAt = new Date().toISOString();
  const evId = Object.keys(db.events)[0];
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
  port = await freePort();
  srv = spawn(process.execPath, [serverPath], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  const base2 = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base2}/api/health`)).ok) break; } catch { /* not up */ } await sleep(300); }

  try {
    const login = await fetch(`${base2}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'o@c.org', password: 'parola-lunga-1' }) });
    const cookie = getCookie(login);
    let token = '';
    await test('owner generates a connection code', async () => {
      const r = await fetch(`${base2}/api/events/${evId}/bridge/code`, { method: 'POST', headers: { Cookie: cookie } });
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.ok(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{7}$/.test(j.code));
      global.__code = j.code;
    });
    await test('code generation needs a session (401 without)', async () => {
      const r = await fetch(`${base2}/api/events/${evId}/bridge/code`, { method: 'POST' });
      assert.strictEqual(r.status, 401);
    });
    await test('exchange returns a token + target languages', async () => {
      const r = await fetch(`${base2}/api/bridge/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: global.__code }) });
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.ok(j.bridgeToken && j.svEventId === evId);
      assert.ok(Array.isArray(j.targetLanguages));
      token = j.bridgeToken;
    });
    await test('exchange with a bad code -> 400', async () => {
      const r = await fetch(`${base2}/api/bridge/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'BADCODE' }) });
      assert.strictEqual(r.status, 400);
    });
    await test('status (token) shows connected; admin status shows connected', async () => {
      const r = await fetch(`${base2}/api/bridge/status`, { headers: { Authorization: 'Bearer ' + token } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await r.json()).connected, true);
      const a = await (await fetch(`${base2}/api/events/${evId}/bridge/status`, { headers: { Cookie: cookie } })).json();
      assert.strictEqual(a.connected, true);
    });
    await test('revoke (worship token) drops the bridge', async () => {
      const r = await fetch(`${base2}/api/bridge/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bridgeToken: token }) });
      assert.strictEqual(r.status, 200);
      const s = await fetch(`${base2}/api/bridge/status`, { headers: { Authorization: 'Bearer ' + token } });
      assert.strictEqual(s.status, 401, 'token inactive after revoke');
    });
  } finally {
    srv.kill('SIGTERM');
  }
}

(async () => {
  await unit();
  await integration();
  if (failures) { console.error(`\nbridge tests: ${failures} failure(s)`); process.exit(1); }
  console.log('\nbridge tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
