# Security audit changes

This document explains the security fixes shipped in commit `6a8bcf0` and what the team needs to configure before / after deploying it.

## TL;DR for ops

Before the next deploy with `COMMERCIAL_MODE=1`, set `ADMIN_SESSION_SECRET` in your environment. If you don't, the process will refuse to start.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the output as `ADMIN_SESSION_SECRET` in Render Environment (or your `.env` for local commercial-mode runs).

---

## What changed

### 1. Cryptographically secure access codes

All access codes are now generated with `crypto.randomBytes` instead of `Math.random()`.

| Code | Old format | New format |
|---|---|---|
| Event admin code | `SV-ADMIN-XXXXX` (5 chars, base36) | `SV-ADMIN-XXXXXXXXXXXX` (12 chars, 32-char unambiguous alphabet) |
| Screen / operator code | `SV-SCREEN-XXXXX` | `SV-SCREEN-XXXXXXXXXXXX` |
| Remote operator code | `SV-REMOTE-XXXXX` | `SV-REMOTE-XXXXXXXXXXXX` |
| Granted operator code | 8 chars | 12 chars |
| Event short ID | 8 chars (already had the right alphabet) | 8 chars, now `randomBytes`-sourced |

The shared alphabet is `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (32 characters, no `0/O`, `1/I/L`). Power-of-two size means `byte % 32` gives unbiased indexing.

**Migration note:** existing codes already saved in `data/sessions.json` are *not* rotated. They keep their old (weak) values. If you want to force rotation, that's a separate task.

### 2. Hardened `ADMIN_SESSION_SECRET` initialization

Old behavior fell back, in order, to `SESSION_SECRET`, then `OPENAI_API_KEY`, then `MASTER_ADMIN_PIN`, then the hardcoded literal `'sanctuary-voice-dev-session'`. That meant a leaked OpenAI key let an attacker forge admin session cookies.

New behavior:

- Reads only `ADMIN_SESSION_SECRET` or `SESSION_SECRET` from env.
- If empty **and** `COMMERCIAL_MODE=1` → prints a fatal error with the generation recipe and `process.exit(1)`.
- If empty **and not** commercial → generates an ephemeral `randomBytes(32).toString('base64')` and logs a warning that admin sessions will be invalidated on the next restart.
- If set but `< 32` characters → logs a warning, but continues.

**Action required:** set `ADMIN_SESSION_SECRET` (≥ 32 characters) in any environment that runs with `COMMERCIAL_MODE=1`. Generate with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 3. Operator code moved out of the URL into an HttpOnly cookie

The remote operator code used to travel as `?code=...` in URLs (`/remote?event=…&code=…`, `/api/operator/join` redirects). That meant it landed in browser history, reverse-proxy logs, `Referer` headers, and accidental shares.

- New cookie: `sv_operator_session`, HMAC-signed (SHA-256, with the `op:` domain prefix mixed into the HMAC input so admin tokens cannot be cross-replayed).
- Lifetime: `OPERATOR_SESSION_MAX_AGE_HOURS` (default `4`).
- Flags: `HttpOnly`, `SameSite=Lax`, `Secure` when the request is HTTPS.
- New endpoint: `POST /api/operator-logout` — clears the cookie.
- `/api/operator-login` sets the cookie after PIN validation. Response still contains `operatorCode` for legacy clients.
- `/api/operator/join` returns `redirectUrl: '/remote?event=ID'` (no `&code=...` anymore).

**Action required:** none, the frontend continues to work because:
- Legacy `?code=...` URLs still resolve via the body / query / header fallback path.
- `getOperatorCodeFromRequest` and `getSuppliedEventCode` now prefer the cookie, then fall back.

You may optionally configure `OPERATOR_SESSION_MAX_AGE_HOURS` in env if 4 hours is the wrong default for your service length.

### 4. Socket.IO server limits

Added to the Socket.IO server config in `server.js`:

| Option | Value | Why |
|---|---|---|
| `maxHttpBufferSize` | `256 * 1024` (256 KB) | Audio chunks are ~3 KB; 256 KB is generous and blocks abusive payloads. |
| `pingInterval` | `20_000` ms | Health-check cadence. |
| `pingTimeout` | `25_000` ms | Faster detection of dead sockets. |
| `connectTimeout` | `30_000` ms | Drop slow / never-finishing connection upgrades. |

### 5. Per-event rate limits and strict input validation on socket events

`socket/handlers.js` was rewritten end-to-end. Every event handler is now wrapped in `on(socket, eventName, handler)`, which:

1. Applies a sliding-window rate limit (state on `socket.data._rl`).
2. Catches any exception, logs it, and emits a generic `server_error` instead of crashing the socket.

| Event | Window | Max |
|---|---|---|
| `join_event` | 60 s | 30 |
| `participant_language` | 60 s | 60 |
| `submit_text` | 60 s | 60 |
| `admin_update_source` | 60 s | 60 |
| `set_audio_state` | 60 s | 120 |
| `set_transcription_state` | 60 s | 60 |
| `end_service` | 60 s | 5 |
| `azure_audio_start` | 60 s | 10 |
| `azure_audio_chunk` | 1 s | 50 |
| `azure_audio_stop` | 60 s | 20 |

When a client exceeds a limit, the server emits `server_error { code: 'rate_limited', event }` but does **not** disconnect.

`disconnect` is intentionally not rate-limited and not wrapped.

Strict type guards were added for all payloads:

- `asString(value, maxLength)` — non-strings → `''`, truncated to `maxLength`.
- `asEventId(value)` — `^[A-Za-z0-9_-]+$`, length 1–128.
- `asLanguageCode(value)` — `^[a-z]{2,5}(?:-[a-z0-9]{2,8})?$/i`.
- `asBool(value)` — strict `=== true`.
- `asNumberInRange(value, min, max)` — clamps; non-finite → `null`.
- `asAudioBuffer(value, maxBytes = 262144)` — accepts `Buffer`, `ArrayBuffer`, TypedArray, numeric `Array`; rejects everything else, empty buffers, and oversized buffers.

`azure_audio_chunk` previously did `Buffer.from(audio || [])` on whatever the client sent — a malformed payload could have been turned into garbage bytes that the Azure stream then choked on. The new path explicitly returns `null` and drops the chunk if it isn't a valid audio buffer.

---

## Environment variables — quick reference

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `ADMIN_SESSION_SECRET` | **Required** when `COMMERCIAL_MODE=1`. Strongly recommended otherwise. | None | ≥ 32 chars. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. |
| `SESSION_SECRET` | Optional | None | Alias for `ADMIN_SESSION_SECRET`. |
| `OPERATOR_SESSION_MAX_AGE_HOURS` | Optional | `4` | Operator cookie lifetime. |
| `ADMIN_SESSION_MAX_AGE_HOURS` | Optional | `12` | Admin cookie lifetime (unchanged in this audit). |
| `COMMERCIAL_MODE` | Optional | `0` | When `1`, refuses to start without `ADMIN_SESSION_SECRET`. |

---

## Deployment checklist

1. Generate a fresh `ADMIN_SESSION_SECRET` (32+ random bytes, base64) and put it in Render Environment **before** deploying.
2. Decide on `OPERATOR_SESSION_MAX_AGE_HOURS` if 4 h is wrong for your service.
3. Deploy. On startup, watch logs for:
   - `FATAL: ADMIN_SESSION_SECRET is not set.` → stop, set it, redeploy.
   - `ADMIN_SESSION_SECRET not set — using an ephemeral random secret.` → only acceptable for non-commercial / dev.
   - `ADMIN_SESSION_SECRET is shorter than 32 characters` → rotate to a longer secret when convenient.
4. After deploy, existing operator sessions are still valid (the cookie wasn't in use before, and legacy `?code=` URLs still work). New operator logins land in the cookie automatically.
5. Old, weak access codes saved in `data/sessions.json` are **not** rotated automatically. Plan a rotation pass if any existing code has been shared insecurely.

## Optional follow-ups

- Strip the `?code=...` legacy parser from `public/remote.js` once you've confirmed the cookie flow is stable in production.
- One-shot migration to regenerate every event's admin / screen / remote-operator code with the new generator and re-share the new links with operators.
- Verify Render volume permissions on `data/` — the persistent translation cache (`data/translation-cache.json`) is loaded as trusted data.
