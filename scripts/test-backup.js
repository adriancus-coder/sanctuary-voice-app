// SV-AUTO-BACKUP test — stands up a mock S3 endpoint over plain HTTP, points the
// backup module at it via BACKUP_S3_* env vars, runs a backup of a temp store,
// and asserts the object was PUT and the state records success. No network.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function log(ok, msg) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const puts = [];
  const objects = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'PUT') {
        puts.push(url.pathname);
        objects.add(url.pathname.replace(/^\/[^/]+\//, '')); // strip /bucket/
        res.writeHead(200).end();
      } else if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') || '';
        const keys = [...objects].filter((k) => k.startsWith(prefix));
        const body =
          '<?xml version="1.0"?><ListBucketResult>' +
          keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('') +
          '<IsTruncated>false</IsTruncated></ListBucketResult>';
        res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
      } else if (req.method === 'DELETE') {
        res.writeHead(204).end();
      } else {
        res.writeHead(200).end();
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-backup-'));
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({ events: {}, ok: true }));

  process.env.BACKUP_S3_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.BACKUP_S3_BUCKET = 'test-bucket';
  process.env.BACKUP_S3_ACCESS_KEY_ID = 'AKIATEST';
  process.env.BACKUP_S3_SECRET_ACCESS_KEY = 'secretTEST';
  process.env.BACKUP_S3_REGION = 'auto';
  process.env.BACKUP_S3_PREFIX = 'sv-test';

  // Require AFTER env is set so config() reads it.
  const backup = require('../lib/backup');
  log(backup.isConfigured(), 'backup reports configured when BACKUP_S3_* present');

  const state = await backup.runBackup({ dataDir, logger: null });
  log(state.ok === true, `runBackup succeeded (error=${state.error || 'none'})`);

  const uploadedSessions = puts.some((p) => /\/daily\/\d{4}-\d{2}-\d{2}\/sessions\.json$/.test(p));
  log(uploadedSessions, `PUT sessions.json into daily folder (${puts.length} object(s) uploaded)`);

  const persisted = backup.readState(dataDir);
  log(persisted && persisted.ok === true, 'backup-state.json records the successful run');

  server.close();
  if (process.exitCode) {
    console.error('\nbackup test failed');
  } else {
    console.log('\nbackup test passed');
  }
}

main().catch((err) => {
  console.error('backup test error:', err);
  process.exit(1);
});
