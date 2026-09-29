// SV-CHECK — boot smoke. Starts the server on a temp DATA_DIR and a free port,
// then requests the core pages and asserts each responds (status < 400,
// redirects allowed). No external tools; uses http + child_process only.
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PAGES = ['/', '/admin', '/worship', '/participant', '/translate', '/api/health'];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function get(port, route) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: route }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(0);
    });
  });
}

async function waitHealthy(port, tries) {
  for (let i = 0; i < tries; i += 1) {
    const code = await get(port, '/api/health');
    if (code === 200) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-smoke-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-smoke-log-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      LOG_DIR: logDir,
      MASTER_ADMIN_PIN: 'smoke',
      ADMIN_SESSION_SECRET: 'smoke-secret-smoke-secret-smoke!',
      OPENAI_API_KEY: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));

  let failed = false;
  try {
    const healthy = await waitHealthy(port, 30);
    if (!healthy) {
      console.error('FAIL  server did not become healthy');
      if (stderr) console.error(stderr.slice(0, 800));
      failed = true;
    } else {
      for (const route of PAGES) {
        const code = await get(port, route);
        const ok = code > 0 && code < 400;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${route} -> ${code}`);
        if (!ok) failed = true;
      }
    }
  } finally {
    child.kill('SIGTERM');
  }

  if (failed) {
    console.error('\nboot smoke failed');
    process.exit(1);
  }
  console.log('\nboot smoke passed');
}

main().catch((err) => {
  console.error('boot smoke error:', err);
  process.exit(1);
});
