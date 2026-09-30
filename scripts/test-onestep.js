// SV-AZURE-ONESTEP smoke — booting with SPEECH_TRANSLATION_PROVIDER=azure but no
// Azure keys must be safe: the app runs and /api/health reports the provider as
// selected yet not available (clean fallback to the OpenAI translate path).
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-onestep-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-onestep-log-'));
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    LOG_DIR: logDir,
    OPENAI_API_KEY: '',
    SPEECH_PROVIDER: 'azure_sdk',        // stream provider selected
    SPEECH_TRANSLATION_PROVIDER: 'azure' // one-step requested...
    // ...but no AZURE_SPEECH_KEY / REGION -> must fall back cleanly.
  };
  delete env.AZURE_SPEECH_KEY;
  delete env.AZURE_SPEECH_REGION;

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  let health = null;
  try {
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) { health = await res.json(); break; }
      } catch { /* not up yet */ }
      await sleep(300);
    }
    let failures = 0;
    const ok = (cond, msg) => { if (cond) { console.log('PASS  ' + msg); } else { failures++; console.error('FAIL  ' + msg); } };
    ok(!!health, 'server booted with SPEECH_TRANSLATION_PROVIDER=azure and no keys');
    ok(health && health.speechTranslationProvider === 'azure', 'health reports one-step provider selected');
    ok(health && health.azureOnestepAvailable === false, 'one-step not available without keys (clean fallback)');
    if (failures) { console.error(`\nonestep smoke: ${failures} failure(s)`); process.exit(1); }
    console.log('\nonestep smoke passed');
  } finally {
    srv.kill('SIGTERM');
  }
})().catch((e) => { console.error(e); process.exit(1); });
