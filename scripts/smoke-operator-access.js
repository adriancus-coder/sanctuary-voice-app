// Smoke test for the operator access flow + admin login (SEC-AUDIT-2026-06 A1/A2).
//
// Self-contained: boots server.js on a throwaway port with a temp DATA_DIR and a
// known admin PIN, exercises the request-access -> request-status -> grant/deny
// flow (including the pollToken gating and timing-safe code checks), prints
// PASS/FAIL per assertion, then tears the server down and removes the temp data.
//
//   node scripts/smoke-operator-access.js
//
// Exit code 0 = all passed, 1 = at least one failure. No external dependencies
// (uses Node 18+ global fetch). Does NOT touch your real data/ dir.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.SMOKE_PORT || '3911';
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PIN = 'smoke-test-pin-1234';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-smoke-'));

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
    failed += 1;
  }
}

// Capture Set-Cookie from a manual-redirect response into a "name=value; ..." string.
function collectCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return raw.map((c) => c.split(';')[0]).join('; ');
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT,
      DATA_DIR: path.join(tmpRoot, 'data'),
      LOG_DIR: path.join(tmpRoot, 'logs'),
      MASTER_ADMIN_PIN: ADMIN_PIN,
      ADMIN_SESSION_SECRET: 'smoke-test-session-secret-please-ignore',
      COMMERCIAL_MODE: '0',
      NODE_ENV: 'test',
      OPENAI_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const cleanup = () => {
    try { server.kill('SIGTERM'); } catch (_) {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    if (!(await waitForHealth())) {
      console.error('Server did not become healthy. Output:\n' + serverLog);
      cleanup();
      process.exit(1);
    }
    console.log(`Server up on ${BASE} (temp data: ${tmpRoot})\n`);

    // --- A1: create an access request, confirm a pollToken is returned ---
    console.log('A1 — request-access / request-status token gating');
    const createRes = await fetch(`${BASE}/api/operator/request-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Tester', contact: 'smoke@test.local' })
    });
    const created = await createRes.json();
    check('request-access returns ok + requestId', created.ok && !!created.requestId);
    check('request-access returns a pollToken', typeof created.pollToken === 'string' && created.pollToken.length > 0);
    const { requestId, pollToken } = created;

    // --- A1: status must be 404 without / with wrong token, 200 only with the right token ---
    const noToken = await fetch(`${BASE}/api/operator/request-status/${requestId}`);
    check('status WITHOUT token -> 404', noToken.status === 404, `got ${noToken.status}`);

    const wrongToken = await fetch(`${BASE}/api/operator/request-status/${requestId}?token=not-the-token`);
    check('status with WRONG token -> 404', wrongToken.status === 404, `got ${wrongToken.status}`);

    const goodToken = await fetch(`${BASE}/api/operator/request-status/${requestId}?token=${encodeURIComponent(pollToken)}`);
    const goodBody = await goodToken.json();
    check('status with CORRECT token -> 200 pending', goodToken.status === 200 && goodBody.status === 'pending', `got ${goodToken.status} ${goodBody.status}`);

    // --- A2: admin login rejects wrong PIN, accepts the configured one ---
    console.log('\nA2 — admin login (timing-safe PIN check)');
    const badLogin = await fetch(`${BASE}/api/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: 'definitely-wrong' }),
      redirect: 'manual'
    });
    check('admin login with WRONG pin -> 403', badLogin.status === 403, `got ${badLogin.status}`);

    const goodLogin = await fetch(`${BASE}/api/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: ADMIN_PIN }),
      redirect: 'manual'
    });
    const adminCookie = collectCookies(goodLogin);
    check('admin login with CORRECT pin -> redirect + session cookie', (goodLogin.status === 302 || goodLogin.status === 303) && !!adminCookie, `status ${goodLogin.status}, cookie ${adminCookie ? 'set' : 'missing'}`);

    // --- A1 end-to-end: admin grants, requester polls with token and gets the code ---
    console.log('\nA1 — full grant flow (admin grants, requester receives code via token)');
    const grantRes = await fetch(`${BASE}/api/admin/access-requests/${requestId}/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ profile: 'full' })
    });
    const granted = await grantRes.json();
    check('admin grant -> ok + operator code', grantRes.status === 200 && granted.ok && !!granted.code, `status ${grantRes.status}`);

    const grant_noToken = await fetch(`${BASE}/api/operator/request-status/${requestId}`);
    check('granted status WITHOUT token still -> 404 (no code leak)', grant_noToken.status === 404, `got ${grant_noToken.status}`);

    const grant_token = await fetch(`${BASE}/api/operator/request-status/${requestId}?token=${encodeURIComponent(pollToken)}`);
    const grantStatus = await grant_token.json();
    check('granted status WITH token -> 200 granted + operatorCode', grant_token.status === 200 && grantStatus.status === 'granted' && grantStatus.operatorCode === granted.code, `status ${grant_token.status} ${grantStatus.status}`);

    // --- grant requires an admin session (unauthenticated must be rejected) ---
    console.log('\nAuthz — grant without admin session is rejected');
    const create2 = await (await fetch(`${BASE}/api/operator/request-access`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second Tester' })
    })).json();
    const unauthGrant = await fetch(`${BASE}/api/admin/access-requests/${create2.requestId}/grant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'full' })
    });
    check('grant without session -> 401', unauthGrant.status === 401, `got ${unauthGrant.status}`);

    // --- deny flow ---
    console.log('\nDeny flow');
    const denyRes = await fetch(`${BASE}/api/admin/access-requests/${create2.requestId}/deny`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({})
    });
    check('admin deny -> ok', denyRes.status === 200, `got ${denyRes.status}`);
    const denied = await (await fetch(`${BASE}/api/operator/request-status/${create2.requestId}?token=${encodeURIComponent(create2.pollToken)}`)).json();
    check('denied status reads back as denied', denied.status === 'denied', `got ${denied.status}`);

  } catch (err) {
    console.error('\nUnexpected error during smoke test:', err && err.stack ? err.stack : err);
    failed += 1;
  } finally {
    cleanup();
  }

  console.log(`\n${'='.repeat(40)}\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
