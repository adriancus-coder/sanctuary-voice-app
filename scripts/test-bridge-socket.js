// SV-BRIDGE-OUT tests — the /bridge socket namespace. Boot the server, seed an
// owner + active event, exchange a code for a token, connect to /bridge, and
// verify: bad token is rejected; an admin submit_text streams translation.final
// (and partials) to the bridge; a revoke disconnects the bridge socket. Uses
// socket.io-client. Exit 0/1.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const accounts = require('../lib/accounts');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.error('FAIL  ' + name + '\n      ' + (e && e.message)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function getCookie(r) { const sc = r.headers.get('set-cookie') || ''; const m = sc.match(/sv_sid=([^;]+)/); return m ? 'sv_sid=' + m[1] : ''; }
function waitFor(socket, event, ms = 6000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for ' + event)), ms);
    socket.once(event, (d) => { clearTimeout(to); resolve(d); });
  });
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-brs-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-brs-log-'));
  const env = { ...process.env, DATA_DIR: dataDir, LOG_DIR: logDir, MASTER_ADMIN_PIN: 'acc', ADMIN_SESSION_SECRET: 'z'.repeat(40), OPENAI_API_KEY: '' };
  const serverPath = path.join(__dirname, '..', 'server.js');
  let port = await freePort();
  let srv = spawn(process.execPath, [serverPath], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* not up */ } await sleep(300); }
  srv.kill('SIGTERM'); await sleep(700);

  const dbFile = path.join(dataDir, 'sessions.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  db.users = [{ id: 'o', email: 'o@c.org', name: 'O', password_hash: accounts.hashPassword('parola-lunga-1'), role: 'owner', active: true, must_change_password: false, created_at: new Date().toISOString(), last_login_at: null }];
  db.authSessions = [];
  db.accountsSetupAt = new Date().toISOString();
  const evId = Object.keys(db.events)[0];
  const adminCode = db.events[evId].adminCode;
  db.events[evId].approved = true; db.events[evId].targetLangs = ['en', 'no'];
  db.organizations[Object.keys(db.organizations)[0]].activeEventId = evId; db.activeEventId = evId;
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));

  port = await freePort();
  srv = spawn(process.execPath, [serverPath], { env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up */ } await sleep(300); }

  const opened = [];
  try {
    // exchange a code for a token
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'o@c.org', password: 'parola-lunga-1' }) });
    const cookie = getCookie(login);
    const codeRes = await (await fetch(`${base}/api/events/${evId}/bridge/code`, { method: 'POST', headers: { Cookie: cookie } })).json();
    const ex = await (await fetch(`${base}/api/bridge/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: codeRes.code }) })).json();
    const token = ex.bridgeToken;

    await test('bad token is rejected by the /bridge namespace', async () => {
      const bad = io(`${base}/bridge`, { auth: { token: 'nope' }, transports: ['websocket'], reconnection: false });
      opened.push(bad);
      const err = await new Promise((resolve) => { bad.on('connect_error', (e) => resolve(e)); bad.on('connect', () => resolve(null)); });
      assert.ok(err, 'connect_error for bad token');
      bad.close();
    });

    const bridgeSock = io(`${base}/bridge`, { auth: { token }, transports: ['websocket'], reconnection: false });
    opened.push(bridgeSock);
    await test('valid token connects and gets bridge.ready with languages', async () => {
      const ready = await waitFor(bridgeSock, 'bridge.ready');
      assert.strictEqual(ready.svEventId, evId);
      assert.deepStrictEqual(ready.targetLanguages, ['en', 'no']);
    });

    // admin socket joins the event, then submits text
    const admin = io(base, { transports: ['websocket'], reconnection: false });
    opened.push(admin);
    await waitFor(admin, 'connect');
    admin.emit('join_event', { eventId: evId, role: 'admin', code: adminCode });
    await waitFor(admin, 'joined_event');

    await test('admin submit_text streams translation.final to the bridge', async () => {
      const finalP = waitFor(bridgeSock, 'translation.final', 8000);
      admin.emit('submit_text', { eventId: evId, text: 'Har și pace vouă.' });
      const entry = await finalP;
      assert.ok(entry && entry.translations, 'final has translations');
      assert.ok('en' in entry.translations && 'no' in entry.translations, 'per-language translations present');
    });

    // A participant joins the live event and should receive bridged lyrics.
    const part = io(base, { transports: ['websocket'], reconnection: false });
    opened.push(part);
    await waitFor(part, 'connect');
    part.emit('join_event', { eventId: evId, role: 'participant', language: 'en' });
    await waitFor(part, 'joined_event');

    await test('song.current -> participant gets translated lyrics', async () => {
      const lyricsP = waitFor(part, 'lyrics', 8000);
      bridgeSock.emit('song.current', { title: 'Isus e Domn', label: 'Vers 1', text: 'Isus e Domn\nîn veci', hash: 'h-verse-1', lang: 'ro' });
      const ly = await lyricsP;
      assert.strictEqual(ly.title, 'Isus e Domn');
      assert.ok(ly.translations && typeof ly.translations.en === 'string' && ly.translations.en.length > 0, 'EN lyrics present');
    });

    await test('setlist.sections is accepted (background pre-translate)', async () => {
      // No throw; a follow-up song.current for the same hash still delivers.
      bridgeSock.emit('setlist.sections', [{ hash: 'h-verse-2', title: 'Mare ești', label: 'Vers 1', text: 'Mare ești Tu', lang: 'ro' }]);
      await sleep(300);
      const lyricsP = waitFor(part, 'lyrics', 8000);
      bridgeSock.emit('song.current', { title: 'Mare ești', label: 'Vers 1', text: 'Mare ești Tu', hash: 'h-verse-2', lang: 'ro' });
      const ly = await lyricsP;
      assert.strictEqual(ly.hash, 'h-verse-2');
    });

    await test('song.clear -> participant gets lyrics_clear', async () => {
      const clearP = waitFor(part, 'lyrics_clear', 6000);
      bridgeSock.emit('song.clear');
      await clearP;
    });

    await test('revoke disconnects the bridge socket', async () => {
      const disc = new Promise((resolve) => bridgeSock.on('disconnect', () => resolve(true)));
      await fetch(`${base}/api/events/${evId}/bridge/revoke`, { method: 'POST', headers: { Cookie: cookie } });
      const got = await Promise.race([disc, sleep(4000).then(() => false)]);
      assert.strictEqual(got, true, 'bridge socket disconnected on revoke');
    });
  } finally {
    opened.forEach((s) => { try { s.close(); } catch { /* ignore */ } });
    srv.kill('SIGTERM');
  }

  if (failures) { console.error(`\nbridge-socket tests: ${failures} failure(s)`); process.exit(1); }
  console.log('\nbridge-socket tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
