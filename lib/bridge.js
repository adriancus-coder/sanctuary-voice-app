'use strict';

// SV-BRIDGE — the worship-app <-> Sanctuary Voice bridge (stage 8). A short-lived
// CONNECTION CODE (generated in SV) is exchanged server-to-server for a BRIDGE
// TOKEN scoped to one SV event, valid until the event ends (+12h here as a
// practical cap), revocable from either side. Tokens are hashed at rest; the
// plaintext is returned to worship-app exactly once. Codes live in memory only
// (short-lived, single use); bridges persist additively in db.bridges.
const crypto = require('crypto');

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // unambiguous
const CODE_LENGTH = 7;                                   // 6-8 chars

function createBridge({ db, saveDb, tokenTtlHours = 12, codeTtlMs = 10 * 60 * 1000 } = {}) {
  const codes = new Map();     // connection code -> { svEventId, expiresAt, used }
  const pairCodes = new Map(); // pairing code    -> { svOrgId, expiresAt, used }

  function ensureStore() {
    if (!Array.isArray(db.bridges)) db.bridges = [];
    return db.bridges;
  }
  // SV-BRIDGE-PAIRING — church pairings persist additively, one row per pairing.
  function ensurePairStore() {
    if (!Array.isArray(db.bridgePairings)) db.bridgePairings = [];
    return db.bridgePairings;
  }
  const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

  function genCode() {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let c = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) c += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return c;
  }

  function pruneCodes() {
    const now = Date.now();
    for (const [k, v] of codes) { if (v.used || v.expiresAt <= now) codes.delete(k); }
  }

  // Operator/owner generates a connection code for an SV event.
  function createCode(svEventId) {
    pruneCodes();
    let code;
    do { code = genCode(); } while (codes.has(code));
    const expiresAt = Date.now() + codeTtlMs;
    codes.set(code, { svEventId: String(svEventId), expiresAt, used: false });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  // Mint a per-event bridge token (one active bridge per SV event: supersede any
  // existing one). Shared by the typed-code exchange and the paired one-tap connect.
  function mintBridge(svEventId) {
    const id = String(svEventId);
    const store = ensureStore();
    store.forEach((b) => { if (b.svEventId === id && !b.revokedAt) b.revokedAt = new Date().toISOString(); });
    const token = crypto.randomBytes(32).toString('hex');
    const bridge = {
      id: crypto.randomUUID(),
      svEventId: id,
      tokenHash: sha(token),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + tokenTtlHours * 3600 * 1000).toISOString(),
      revokedAt: null,
      lastSeenAt: null
    };
    store.push(bridge);
    if (typeof saveDb === 'function') saveDb();
    return { bridge, token };
  }

  // worship-app exchanges the code (server-to-server) for a bridge token.
  function exchange(rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    const rec = codes.get(code);
    if (!rec) return { error: 'invalid_code' };
    if (rec.used) { return { error: 'code_used' }; }
    if (rec.expiresAt <= Date.now()) { codes.delete(code); return { error: 'code_expired' }; }
    rec.used = true;
    codes.delete(code);
    return mintBridge(rec.svEventId);
  }

  // ---- SV-BRIDGE-PAIRING — church pairing (one-time), then one-tap connect ----
  // A one-time pairing code (generated in SV admin) is exchanged for a long-lived
  // pairing token scoped to the SV organisation, stored hashed at rest. The token
  // then lists events and connects any one of them without a fresh code.
  function prunePairCodes() {
    const now = Date.now();
    for (const [k, v] of pairCodes) { if (v.used || v.expiresAt <= now) pairCodes.delete(k); }
  }

  // Admin generates a one-time pairing code for an SV organisation.
  function createPairingCode(svOrgId) {
    prunePairCodes();
    let code;
    do { code = genCode(); } while (pairCodes.has(code) || codes.has(code));
    const expiresAt = Date.now() + codeTtlMs;
    pairCodes.set(code, { svOrgId: String(svOrgId), expiresAt, used: false });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  // worship-app pairs once: pairing code -> long-lived pairing token.
  function pair(rawCode, churchName) {
    const code = String(rawCode || '').trim().toUpperCase();
    const rec = pairCodes.get(code);
    if (!rec) return { error: 'invalid_code' };
    if (rec.used) return { error: 'code_used' };
    if (rec.expiresAt <= Date.now()) { pairCodes.delete(code); return { error: 'code_expired' }; }
    rec.used = true;
    pairCodes.delete(code);
    const token = crypto.randomBytes(32).toString('hex');
    const pairing = {
      id: crypto.randomUUID(),
      svOrgId: rec.svOrgId,
      churchName: String(churchName || '').slice(0, 200),
      tokenHash: sha(token),
      tokenFingerprint: sha(token).slice(0, 8), // for logs, never the token
      createdAt: new Date().toISOString(),
      revokedAt: null,
      lastSeenAt: null
    };
    ensurePairStore().push(pairing);
    if (typeof saveDb === 'function') saveDb();
    return { pairing, token };
  }

  function findPairingByToken(token) {
    if (!token) return null;
    const h = sha(token);
    return ensurePairStore().find((p) => p.tokenHash === h) || null;
  }
  function isPairingActive(p) {
    return !!p && !p.revokedAt; // long-lived: no expiry, revocable from either side
  }
  function touchPairing(p) {
    if (!p) return;
    p.lastSeenAt = new Date().toISOString();
    if (typeof saveDb === 'function') saveDb();
  }
  function unpairByToken(token) {
    const p = findPairingByToken(token);
    if (!p || p.revokedAt) return false;
    p.revokedAt = new Date().toISOString();
    if (typeof saveDb === 'function') saveDb();
    return true;
  }
  // A paired, one-tap connect to a chosen event: the same per-event bridge token as
  // the typed-code exchange, so everything after the handshake is unchanged.
  function connectPaired(pairing, svEventId) {
    return mintBridge(svEventId);
  }

  function isActive(b) {
    return !!b && !b.revokedAt && new Date(b.expiresAt).getTime() > Date.now();
  }
  function findByToken(token) {
    if (!token) return null;
    const h = sha(token);
    return ensureStore().find((b) => b.tokenHash === h) || null;
  }
  function findActiveForEvent(eventId) {
    return ensureStore().find((b) => b.svEventId === String(eventId) && isActive(b)) || null;
  }
  function touch(b) {
    if (!b) return;
    b.lastSeenAt = new Date().toISOString();
    if (typeof saveDb === 'function') saveDb();
  }
  function revokeByToken(token) {
    const b = findByToken(token);
    if (!isActive(b)) return false;
    b.revokedAt = new Date().toISOString();
    if (typeof saveDb === 'function') saveDb();
    return true;
  }
  function revokeForEvent(eventId) {
    let any = false;
    ensureStore().forEach((b) => { if (b.svEventId === String(eventId) && !b.revokedAt) { b.revokedAt = new Date().toISOString(); any = true; } });
    if (any && typeof saveDb === 'function') saveDb();
    return any;
  }

  return {
    createCode, exchange, findByToken, isActive, findActiveForEvent,
    touch, revokeByToken, revokeForEvent, ensureStore, _codes: codes,
    // SV-BRIDGE-PAIRING
    createPairingCode, pair, findPairingByToken, isPairingActive, touchPairing,
    unpairByToken, connectPaired, ensurePairStore, _pairCodes: pairCodes
  };
}

module.exports = { createBridge };
