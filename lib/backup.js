// SV-AUTO-BACKUP — nightly backup of the JSON store to S3-compatible storage
// (Cloudflare R2, Backblaze B2, MinIO, AWS S3). No AWS SDK: AWS Signature V4 is
// implemented in-house with the crypto module. The whole feature is inert
// unless the BACKUP_S3_* env vars are present, so it never affects a server
// that hasn't opted in.
//
// Env:
//   BACKUP_S3_ENDPOINT           e.g. https://<account>.r2.cloudflarestorage.com
//   BACKUP_S3_BUCKET             bucket name
//   BACKUP_S3_ACCESS_KEY_ID
//   BACKUP_S3_SECRET_ACCESS_KEY
//   BACKUP_S3_REGION             optional, default "auto" (R2). Use "us-east-1" for AWS.
//   BACKUP_S3_PREFIX             optional key prefix, default "sanctuary-voice"
//
// Layout in the bucket:
//   <prefix>/daily/YYYY-MM-DD/<file>
//   <prefix>/weekly/YYYY-Www/<file>   (a copy taken on Sundays)
// Rotation keeps 14 daily folders and 8 weekly folders.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DAILY_KEEP = 14;
const WEEKLY_KEEP = 8;

function env(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : '';
}

function config() {
  const endpoint = env('BACKUP_S3_ENDPOINT');
  const bucket = env('BACKUP_S3_BUCKET');
  const accessKeyId = env('BACKUP_S3_ACCESS_KEY_ID');
  const secretAccessKey = env('BACKUP_S3_SECRET_ACCESS_KEY');
  const region = env('BACKUP_S3_REGION') || 'auto';
  const prefix = (env('BACKUP_S3_PREFIX') || 'sanctuary-voice').replace(/\/+$/, '');
  const configured = !!(endpoint && bucket && accessKeyId && secretAccessKey);
  return { endpoint, bucket, accessKeyId, secretAccessKey, region, prefix, configured };
}

function isConfigured() {
  return config().configured;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hmac(key, str) {
  return crypto.createHmac('sha256', key).update(str, 'utf8').digest();
}

// RFC 3986 encoding; keep unreserved chars. For the path we keep "/".
function uriEncode(str, keepSlash) {
  let out = '';
  for (const ch of Buffer.from(String(str), 'utf8').toString('latin1')) {
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === '/')) {
      out += ch;
    } else {
      out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

// Build a signed S3 request and perform it. Path-style addressing:
// <endpoint>/<bucket>/<key>?<query>. Returns { status, headers, body }.
function s3Request(cfg, { method, key, query, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const url = new URL(cfg.endpoint);
    const isHttps = url.protocol === 'https:';
    const host = url.host;
    const basePath = url.pathname.replace(/\/+$/, ''); // usually ""
    const encodedKey = key ? '/' + uriEncode(key, true) : '';
    const canonicalUri = `${basePath}/${uriEncode(cfg.bucket, false)}${encodedKey}`;

    const queryPairs = Object.entries(query || {})
      .map(([k, v]) => [uriEncode(k, false), uriEncode(v == null ? '' : v, false)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join('&');

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(payload);

    const headers = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (method === 'PUT') headers['content-type'] = 'application/octet-stream';

    const signedHeaderNames = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort();
    const canonicalHeaders =
      signedHeaderNames.map((h) => `${h}:${String(headers[h]).trim()}`).join('\n') + '\n';
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
    ].join('\n');

    const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, cfg.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const reqHeaders = { ...headers, Authorization: authorization };
    if (method === 'PUT') reqHeaders['content-length'] = payload.length;

    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        method,
        host: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: canonicalUri + (canonicalQuery ? `?${canonicalQuery}` : ''),
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function putObject(cfg, key, body) {
  const res = await s3Request(cfg, { method: 'PUT', key, body });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`PUT ${key} -> ${res.status} ${res.body.slice(0, 300)}`);
  }
  return res;
}

async function listKeys(cfg, prefix) {
  const keys = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const res = await s3Request(cfg, { method: 'GET', query });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`LIST -> ${res.status} ${res.body.slice(0, 300)}`);
    }
    for (const m of res.body.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    const trunc = /<IsTruncated>true<\/IsTruncated>/.test(res.body);
    const next = res.body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = trunc && next ? next[1] : null;
  } while (token);
  return keys;
}

async function deleteKey(cfg, key) {
  const res = await s3Request(cfg, { method: 'DELETE', key });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`DELETE ${key} -> ${res.status}`);
  }
}

// Collect the files to back up: sessions.json (required), translation-cache.json
// if present, and anything under DATA_DIR/uploads. Audio archives are excluded.
function collectFiles(dataDir) {
  const files = [];
  const add = (abs, rel) => {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) files.push({ abs, rel });
  };
  add(path.join(dataDir, 'sessions.json'), 'sessions.json');
  add(path.join(dataDir, 'translation-cache.json'), 'translation-cache.json');
  const uploads = path.join(dataDir, 'uploads');
  if (fs.existsSync(uploads) && fs.statSync(uploads).isDirectory()) {
    const walk = (dir, base) => {
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        const rel = base ? `${base}/${name}` : name;
        const st = fs.statSync(abs);
        if (st.isDirectory()) walk(abs, rel);
        else files.push({ abs, rel: `uploads/${rel}` });
      }
    };
    walk(uploads, '');
  }
  return files;
}

function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function stateFile(dataDir) {
  return path.join(dataDir, 'backup-state.json');
}

function readState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(dataDir, state) {
  try {
    fs.writeFileSync(stateFile(dataDir), JSON.stringify(state, null, 2));
  } catch {
    /* best effort */
  }
}

// Delete daily/weekly folders beyond the retention counts.
async function rotate(cfg, logger) {
  const dailyKeys = await listKeys(cfg, `${cfg.prefix}/daily/`);
  const weeklyKeys = await listKeys(cfg, `${cfg.prefix}/weekly/`);
  const folders = (keys, re) => {
    const set = new Set();
    for (const k of keys) {
      const m = k.match(re);
      if (m) set.add(m[1]);
    }
    return Array.from(set).sort();
  };
  const daily = folders(dailyKeys, new RegExp(`${cfg.prefix}/daily/([^/]+)/`));
  const weekly = folders(weeklyKeys, new RegExp(`${cfg.prefix}/weekly/([^/]+)/`));
  const dropDaily = daily.slice(0, Math.max(0, daily.length - DAILY_KEEP));
  const dropWeekly = weekly.slice(0, Math.max(0, weekly.length - WEEKLY_KEEP));
  for (const folder of dropDaily) {
    for (const k of dailyKeys.filter((k) => k.startsWith(`${cfg.prefix}/daily/${folder}/`))) {
      await deleteKey(cfg, k);
    }
  }
  for (const folder of dropWeekly) {
    for (const k of weeklyKeys.filter((k) => k.startsWith(`${cfg.prefix}/weekly/${folder}/`))) {
      await deleteKey(cfg, k);
    }
  }
  if ((dropDaily.length || dropWeekly.length) && logger) {
    logger.info(`[backup] rotated: -${dropDaily.length} daily, -${dropWeekly.length} weekly`);
  }
}

async function runBackup({ dataDir, logger }) {
  const cfg = config();
  if (!cfg.configured) return { configured: false };
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const files = collectFiles(dataDir);
  const state = { lastAt: now.toISOString(), ok: false, key: null, files: files.length, error: null };
  try {
    if (!files.length) throw new Error('no files to back up (sessions.json missing?)');
    const dailyPrefix = `${cfg.prefix}/daily/${day}`;
    for (const f of files) {
      await putObject(cfg, `${dailyPrefix}/${f.rel}`, fs.readFileSync(f.abs));
    }
    // Sunday copy → weekly
    if (now.getUTCDay() === 0) {
      const weeklyPrefix = `${cfg.prefix}/weekly/${isoWeek(now)}`;
      for (const f of files) {
        await putObject(cfg, `${weeklyPrefix}/${f.rel}`, fs.readFileSync(f.abs));
      }
    }
    await rotate(cfg, logger);
    state.ok = true;
    state.key = `${dailyPrefix}/sessions.json`;
    if (logger) logger.info(`[backup] uploaded ${files.length} file(s) to ${dailyPrefix}`);
  } catch (err) {
    state.error = err && err.message ? err.message : String(err);
    if (logger) logger.error('[backup] failed:', state.error);
  }
  writeState(dataDir, state);
  return state;
}

module.exports = { config, isConfigured, runBackup, readState };
