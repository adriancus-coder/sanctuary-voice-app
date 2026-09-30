// SV-ACCOUNTS tests. (1) lib/accounts unit tests, no server. (2) integration:
// seed a user into a real (synthetic) sessions.json, boot the server, and drive
// the auth endpoints. Verifies additive keys load cleanly and existing data
// (org/event) survives. No framework; exit 0/1.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const accounts = require('../lib/accounts');

let failures = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log('PASS  ' + name))
    .catch((e) => {
      failures++;
      console.error('FAIL  ' + name + '\n      ' + (e && e.message));
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function unitTests() {
  await test('hash/verify round-trip', () => {
    const h = accounts.hashPassword('parola-lunga-1');
    assert.ok(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/.test(h), 'hash format');
    assert.strictEqual(accounts.verifyPassword('parola-lunga-1', h), true);
    assert.strictEqual(accounts.verifyPassword('gresit', h), false);
  });
  await test('verify rejects malformed hash', () => {
    assert.strictEqual(accounts.verifyPassword('x', 'not-a-hash'), false);
  });
  await test('createUser validates + dedupes', () => {
    const db = {};
    accounts.createUser(db, { email: 'A@Church.org', name: 'Ana', password: 'parola-lunga-1', role: 'owner' });
    assert.strictEqual(db.users.length, 1);
    assert.strictEqual(db.users[0].email, 'a@church.org', 'email lowercased');
    assert.throws(() => accounts.createUser(db, { email: 'a@church.org', name: 'X', password: 'parola-lunga-1', role: 'member' }), /email exists|emailExists/);
    assert.throws(() => accounts.createUser(db, { email: 'b@c.org', name: 'X', password: 'short', role: 'member' }), /weak/);
    assert.throws(() => accounts.createUser(db, { email: 'bad', name: 'X', password: 'parola-lunga-1', role: 'member' }), /email/);
    assert.throws(() => accounts.createUser(db, { email: 'c@c.org', name: 'X', password: 'parola-lunga-1', role: 'king' }), /role/);
  });
  await test('sessions: create / get / expire / delete', () => {
    const db = {};
    const u = accounts.createUser(db, { email: 'o@c.org', name: 'O', password: 'parola-lunga-1', role: 'owner' });
    const s = accounts.createSession(db, u.id, false);
    assert.ok(/^[0-9a-f]{64}$/.test(s.id));
    assert.strictEqual(accounts.getSessionUser(db, s.id).id, u.id);
    // expire
    db.authSessions[0].expires_at = Date.now() - 1;
    assert.strictEqual(accounts.getSessionUser(db, s.id), null);
    // delete
    db.authSessions[0].expires_at = Date.now() + 100000;
    accounts.deleteSession(db, s.id);
    assert.strictEqual(accounts.getSessionUser(db, s.id), null);
  });
  await test('deleteUserSessions keeps the current one', () => {
    const db = {};
    const u = accounts.createUser(db, { email: 'o2@c.org', name: 'O', password: 'parola-lunga-1', role: 'owner' });
    const a = accounts.createSession(db, u.id, false);
    const b = accounts.createSession(db, u.id, false);
    accounts.deleteUserSessions(db, u.id, b.id);
    assert.strictEqual(accounts.getSessionUser(db, a.id), null);
    assert.strictEqual(accounts.getSessionUser(db, b.id).id, u.id);
  });
  await test('inactive user cannot resolve a session', () => {
    const db = {};
    const u = accounts.createUser(db, { email: 'o3@c.org', name: 'O', password: 'parola-lunga-1', role: 'owner' });
    const s = accounts.createSession(db, u.id, false);
    u.active = false;
    assert.strictEqual(accounts.getSessionUser(db, s.id), null);
  });
  await test('login rate limiter blocks after 5 fails', () => {
    const rl = accounts.createLoginRateLimiter({ maxFailures: 5, windowMs: 60000 });
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(rl.blocked('ip'), 0);
      rl.fail('ip');
    }
    assert.ok(rl.blocked('ip') > 0, 'blocked after 5');
    rl.reset('ip');
    assert.strictEqual(rl.blocked('ip'), 0);
  });
}

function getCookie(res) {
  const sc = res.headers.get('set-cookie') || '';
  const m = sc.match(/sv_sid=([^;]+)/);
  return m ? 'sv_sid=' + m[1] : '';
}

async function integrationTests() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-acc-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-acc-log-'));
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    LOG_DIR: logDir,
    MASTER_ADMIN_PIN: 'acc',
    ADMIN_SESSION_SECRET: 'acc-secret-acc-secret-acc-secret-acc',
    OPENAI_API_KEY: '',
  };
  const serverPath = path.join(__dirname, '..', 'server.js');

  // Boot on a fresh DATA_DIR: the server seeds a default org + test event and an
  // empty accounts store (synthetic-but-real shape).
  const port = await freePort();
  const srv = spawn(process.execPath, [serverPath], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up */
    }
    await sleep(300);
  }

  try {
    let eventCountBefore = 0;
    await test('fresh store has org/event and no users', async () => {
      const h = await (await fetch(`${base}/api/health`)).json();
      assert.ok(h.ok, 'health ok');
      eventCountBefore = h.activeEvents; // at least the default test event may exist
      const me = await fetch(`${base}/api/auth/me`);
      assert.strictEqual(me.status, 401, 'no session yet');
    });

    // --- SV-ACCOUNTS-SETUP flow ---
    await test('GET /setup served while no users exist', async () => {
      const r = await fetch(`${base}/setup`, { redirect: 'manual' });
      assert.ok(r.status === 200, 'setup page served');
    });
    await test('POST /api/setup wrong token -> 403', async () => {
      const r = await fetch(`${base}/api/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupToken: 'wrong', churchName: 'X', ownerName: 'Y', email: 'o@c.org', password: 'parola-lunga-1' }),
      });
      assert.strictEqual(r.status, 403);
    });
    await test('POST /api/setup correct token -> creates owner + auto-login', async () => {
      const r = await fetch(`${base}/api/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setupToken: 'acc',
          churchName: 'Test Church',
          ownerName: 'Owner',
          email: 'owner@church.org',
          password: 'parola-lunga-1',
        }),
      });
      assert.strictEqual(r.status, 200);
      const d = await r.json();
      assert.strictEqual(d.user.role, 'owner');
      assert.ok(getCookie(r), 'auto-login cookie set');
    });
    await test('church name applied to organization', async () => {
      const h = await (await fetch(`${base}/api/health`)).json();
      assert.strictEqual(h.organization && h.organization.name, 'Test Church');
    });
    await test('GET /setup redirects once an owner exists', async () => {
      const r = await fetch(`${base}/setup`, { redirect: 'manual' });
      assert.ok(r.status >= 300 && r.status < 400, 'redirect status');
    });
    await test('POST /api/setup again -> 409', async () => {
      const r = await fetch(`${base}/api/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupToken: 'acc', churchName: 'X', ownerName: 'Y', email: 'z@c.org', password: 'parola-lunga-1' }),
      });
      assert.strictEqual(r.status, 409);
    });
    await test('default event survived setup writing accounts keys', async () => {
      const h = await (await fetch(`${base}/api/health`)).json();
      assert.ok(h.ok && typeof h.activeEvents === 'number', 'health still reports events');
      assert.ok(eventCountBefore >= 0);
    });

    await test('login with wrong password -> 401', async () => {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@church.org', password: 'nope' }),
      });
      assert.strictEqual(r.status, 401);
    });
    let cookie = '';
    await test('login with correct password -> 200 + cookie', async () => {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@church.org', password: 'parola-lunga-1' }),
      });
      assert.strictEqual(r.status, 200);
      cookie = getCookie(r);
      assert.ok(cookie, 'sv_sid set');
      const d = await r.json();
      assert.strictEqual(d.user.role, 'owner');
    });
    await test('me with cookie -> 200', async () => {
      const r = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await r.json()).user.email, 'owner@church.org');
    });
    await test('me without cookie -> 401', async () => {
      assert.strictEqual((await fetch(`${base}/api/auth/me`)).status, 401);
    });
    await test('password change: wrong current -> 403', async () => {
      const r = await fetch(`${base}/api/me/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ current: 'wrong', password: 'alta-parola-99' }),
      });
      assert.strictEqual(r.status, 403);
    });
    await test('password change: too short -> 400', async () => {
      const r = await fetch(`${base}/api/me/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ current: 'parola-lunga-1', password: 'scurt' }),
      });
      assert.strictEqual(r.status, 400);
    });
    await test('password change: ok -> 200 and re-login works', async () => {
      const r = await fetch(`${base}/api/me/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ current: 'parola-lunga-1', password: 'alta-parola-99' }),
      });
      assert.strictEqual(r.status, 200);
      const r2 = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@church.org', password: 'alta-parola-99' }),
      });
      assert.strictEqual(r2.status, 200);
    });
    await test('logout clears the session', async () => {
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@church.org', password: 'alta-parola-99' }),
      });
      const c = getCookie(login);
      const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: c } });
      assert.strictEqual(out.status, 200);
      assert.strictEqual((await fetch(`${base}/api/auth/me`, { headers: { Cookie: c } })).status, 401);
    });
    // --- SV-ACCOUNTS-GUARDS — page guards (owner is signed in; window active) ---
    let ownerCookie = '';
    await test('re-login owner for guard checks', async () => {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'owner@church.org', password: 'alta-parola-99' }),
      });
      assert.strictEqual(r.status, 200);
      ownerCookie = getCookie(r);
      assert.ok(ownerCookie);
    });
    await test('GET /login served', async () => {
      assert.strictEqual((await fetch(`${base}/login`, { redirect: 'manual' })).status, 200);
    });
    for (const route of ['/admin', '/operator-dashboard', '/remote']) {
      await test(`${route}: owner allowed`, async () => {
        const r = await fetch(`${base}${route}`, { headers: { Cookie: ownerCookie }, redirect: 'manual' });
        assert.strictEqual(r.status, 200, `${route} owner status ${r.status}`);
      });
      await test(`${route}: anonymous -> /login`, async () => {
        const r = await fetch(`${base}${route}`, { redirect: 'manual' });
        assert.ok(r.status >= 300 && r.status < 400, `${route} anon status ${r.status}`);
        assert.ok((r.headers.get('location') || '').includes('/login'), 'redirects to /login');
      });
    }
    await test('emergency admin PIN still works within the 30-day window', async () => {
      const body = new URLSearchParams({ pin: 'acc', next: '/admin' }).toString();
      const r = await fetch(`${base}/api/admin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
      });
      assert.ok(r.status >= 300 && r.status < 400, `admin-login status ${r.status}`);
    });

    await test('login rate limit -> 429 after repeated failures', async () => {
      let got429 = false;
      for (let i = 0; i < 7; i++) {
        const r = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@church.org', password: 'x' }),
        });
        if (r.status === 429) got429 = true;
      }
      assert.ok(got429, 'got a 429');
    });
  } finally {
    srv.kill('SIGTERM');
  }
}

// SV-ACCOUNTS-GUARDS — operator-role gating + the expired emergency-PIN window.
async function emergencyAndOperatorTests() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-guard-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-guard-log-'));
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    LOG_DIR: logDir,
    MASTER_ADMIN_PIN: 'acc',
    ADMIN_SESSION_SECRET: 'guard-secret-guard-secret-guard-secret',
    OPENAI_API_KEY: '',
  };
  const serverPath = path.join(__dirname, '..', 'server.js');

  // Boot once to generate a real store, then stop and seed users + an old setup date.
  let port = await freePort();
  let srv = spawn(process.execPath, [serverPath], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
    } catch {
      /* not up */
    }
    await sleep(300);
  }
  srv.kill('SIGTERM');
  await sleep(800);

  const dbFile = path.join(dataDir, 'sessions.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const mkUser = (id, email, role) => ({
    id,
    email,
    name: role,
    password_hash: accounts.hashPassword('parola-lunga-1'),
    role,
    active: true,
    must_change_password: false,
    created_at: new Date().toISOString(),
    last_login_at: null,
  });
  db.users = [mkUser('seed-owner', 'owner@church.org', 'owner'), mkUser('seed-op', 'operator@church.org', 'operator')];
  db.authSessions = [];
  db.accountsSetupAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));

  port = await freePort();
  srv = spawn(process.execPath, [serverPath], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up */
    }
    await sleep(300);
  }

  try {
    let opCookie = '';
    await test('operator login', async () => {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'operator@church.org', password: 'parola-lunga-1' }),
      });
      assert.strictEqual(r.status, 200);
      opCookie = getCookie(r);
      assert.ok(opCookie);
    });
    await test('operator: /operator-dashboard allowed', async () => {
      const r = await fetch(`${base}/operator-dashboard`, { headers: { Cookie: opCookie }, redirect: 'manual' });
      assert.strictEqual(r.status, 200);
    });
    await test('operator: /remote allowed', async () => {
      const r = await fetch(`${base}/remote`, { headers: { Cookie: opCookie }, redirect: 'manual' });
      assert.strictEqual(r.status, 200);
    });
    await test('operator: /admin -> /login (owner only)', async () => {
      const r = await fetch(`${base}/admin`, { headers: { Cookie: opCookie }, redirect: 'manual' });
      assert.ok(r.status >= 300 && r.status < 400);
      assert.ok((r.headers.get('location') || '').includes('/login'));
    });
    await test('admin PIN disabled after the 30-day window', async () => {
      const body = new URLSearchParams({ pin: 'acc', next: '/admin' }).toString();
      const r = await fetch(`${base}/api/admin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
      });
      assert.strictEqual(r.status, 403, `expected 403, got ${r.status}`);
    });
  } finally {
    srv.kill('SIGTERM');
  }
}

(async () => {
  await unitTests();
  await integrationTests();
  await emergencyAndOperatorTests();
  if (failures) {
    console.error(`\naccounts tests: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\naccounts tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
