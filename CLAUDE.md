# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sanctuary Voice — a single Node/Express + Socket.IO process that delivers live transcription and translation of a church service to four browser experiences served from `public/`:

- `/admin` (or `/admin.html`) — operator console (PIN-gated)
- `/translate`, `/main-screen`, `/song` — all serve `public/translate.html`; the same big-screen UI swaps modes
- `/participant`, `/live` — phone view (`public/participant.html`)
- `/remote` — remote operator view (`public/remote.html`)

There is no build step, no lint config, and no test suite. `npm start` runs `node server.js`. Node 18+ is required.

## Common commands

```bash
npm install
npm start                  # node server.js, default PORT=3000
PORT=3899 npm start        # alternate port (used in local probing — see .claude/settings.local.json)
node --check server.js     # syntax check; same for routes/*.js, socket/handlers.js
curl -s http://127.0.0.1:3000/api/health   # liveness + config snapshot
```

There are no unit tests. Validate changes by `node --check`, hitting `/api/health`, and exercising the live UI pages.

## Architecture

### One big server file + thin extracted modules

`server.js` (~4.2k lines) owns almost everything: state, helpers, all REST handlers that need shared closures, OpenAI/Azure speech orchestration, and the Socket.IO wiring. Three route modules and one socket module receive a large `ctx` object of shared functions and state, and register their handlers:

- `routes/admin.js` — `/api/admin-login`, `/api/admin-logout` (PIN, rate-limited, cookie session)
- `routes/org.js` — `/api/health`, `/api/languages`, `/api/organization`, `/api/participant-qr.png`, push subscribe/unsubscribe
- `routes/events.js` — the bulk of the REST surface: events CRUD, transcripts, songs, glossary, transcribe upload, audit log, summaries, etc.
- `socket/handlers.js` — `join_event`, `submit_text`, source edits, audio mute/state, transcription pause, `azure_audio_*` streaming, disconnect cleanup
- `lib/db.js` — JSON file store (`data/sessions.json`) with once-per-day rotating backups (`sessions.backup-YYYY-MM-DD.json`, retention 7) and `statfsSync` disk info
- `lib/logger.js` — file logger (rotates `logs/app.log` at 5MB, keeps 3 archives)
- `lib/translation.js` — thin OpenAI Responses API wrapper exposing non-streaming, detailed (with token usage), and **streaming** translate calls plus `transcribeAudioFile`

When adding a new endpoint or socket event, decide first whether it needs closures from `server.js`. If yes, register it inside `server.js` and only extract once the surface area justifies a new module; if it can take everything via `ctx`, add it to the matching route/socket file and pass the new dependencies through the `register*` call site in `server.js` (around lines 4080 and 4167).

### Single-process state model

There is no external database. Everything lives in memory and is mirrored to `data/sessions.json` via `saveDb()`:

- `db.organizations[orgId]` — org config, memory/glossary, song library, pinned text library, audit log, access requests, granted operators
- `db.events[eventId]` — transcripts, target languages, display state, song state, audio mute/volume, codes, push subscriptions, audio archive metadata
- `db.activeOrganizationId`, `db.activeEventId`, `db.globalMemory`, `db.globalSongLibrary`, `db.pinnedTextLibrary`, `db.globalAccess`

In-memory only (rebuilt on restart): `participantPresence`, `azureSpeechSessions`, `speechBuffers`, `transcribeRateLimits`, `translationCache` (with separate persistent mirror at `data/translation-cache.json`, capped at `TRANSLATION_CACHE_LIMIT`).

`saveDb()` is called eagerly after almost every mutation. Don't introduce a new mutation path that forgets it; downstream the next process restart will silently lose the change.

### Live transcription pipeline

Two providers, selected by `SPEECH_PROVIDER`:

1. **openai** (default) — admin client uploads short audio chunks to `POST /api/events/:id/transcribe` (rate-limited by `TRANSCRIBE_RATE_LIMIT_*`); server runs `transcribeAudioFile` and feeds text into `processText`.
2. **azure_sdk** — continuous streaming via Microsoft Cognitive Services Speech SDK. Driven over Socket.IO with `azure_audio_start` / `azure_audio_chunk` / `azure_audio_stop`. Sessions tracked in `azureSpeechSessions` keyed by `socket.id`; closed in `disconnect` and on `gracefulShutdown`.

Both paths land in `processText(event, cleanText)` → `publishNewChunk` → fan out per target language. Translations are streamed token-by-token via `lib/translation.js#translateWithResponsesStreaming` and emitted as `display_live_entry_partial` to the event room (throttled to ~120ms per language). When all languages finish, the final entry is emitted as `transcript_entry` and (if display is in `auto` mode) `display_live_entry`. Per-language progressive emit is intentional — each language reaches participants as soon as it's ready, not after the slowest one (recent commits 03875dc, e1dbef5, a5b57dc, 9397e2c, b414769 are all latency tightening).

Audio is optionally archived to `AUDIO_ARCHIVE_DIR` per event id, capped by `AUDIO_ARCHIVE_MAX_BYTES_PER_EVENT`.

### Auth, sessions, and access

- **Admin PIN gate** — `MASTER_ADMIN_PIN` (or `APP_ADMIN_PIN`). `/admin*` redirects to `/admin-login` when no valid session cookie is present. Login attempts are rate-limited per IP (15 / 10 min). Cookie is signed with `ADMIN_SESSION_SECRET` (HMAC), HttpOnly; per-session by default, persistent if `ADMIN_SESSION_PERSISTENT=1`.
- **Operator PIN** — `MAIN_OPERATOR_PIN` (or `MAIN_OPERATOR_CODE`) for screen/operator role on `/api/operator-login`.
- **Per-event access codes** — events have admin/screen codes; `resolveEventAccessFromCode` resolves the role and permission set. Socket `join_event` enforces this for `admin` / `screen` / `participant_preview`; participants can join active events without a code.
- **Remote operators** — named, scoped operators with profiles `main_screen` / `song_only` / `main_and_song` / `full`; `permissions` array gates socket actions via `socketCanControlEvent(socket, eventId, perm)`.
- **Hostname routing** — when the request hits a host listed in `ADMIN_APP_HOSTNAMES`, `/` redirects to `/admin`; otherwise it serves the landing page. `ADMIN_APP_BASE_URL` is used to redirect admin traffic from the public domain to the app subdomain.

### Real-time event rooms

For each event, sockets join:

- `event:<id>` — everyone
- `event:<id>:admins` — admin sockets
- `event:<id>:screens` — screen/operator sockets
- `event:<id>:lang:<code>` — participants filtered by chosen language

Most server emits target the broad `event:<id>` room and the client filters by language; partial-translation emits include the entry id so the client can match deltas to the in-progress entry.

### Frontend layout (vanilla JS)

`public/` is plain ES modules / scripts loaded by HTML pages — `app.js`, `participant.js`, `remote.js`, `song.js`, `translate.js`, `operator-dashboard.js`. There is no bundler. Service worker for push lives at `public/push-sw.js`; PWA manifest at `public/manifest.webmanifest`. `landing.html` is the public marketing page served at `/` and `/home`.

## Things that bite

- **Don't mock or wildcard CORS.** Socket.IO and Express CORS go through `socketCorsOriginValidator` / `expressCorsMiddleware`, which only accept `PUBLIC_BASE_URL`, `ADMIN_APP_BASE_URL`, `ADMIN_APP_HOSTNAMES`, and `localhost`. Adding a domain means updating `buildAllowedCorsOrigins` and likely `buildHelmetConnectSources` for CSP `connectSrc`.
- **Helmet CSP is real and strict.** External scripts/fetches need to be added to the helmet `connectSrc` / `scriptSrc` lists in `server.js` (~line 128); otherwise the browser blocks them silently.
- **Default org and default test event are auto-created.** On startup, if no events exist for `DEFAULT_ORG_ID`, a hidden test event is seeded by `ensureDefaultEvent`. Code that scans events should expect this to exist even on a fresh data dir.
- **`COMMERCIAL_MODE=1` changes admin behavior.** It blocks public first-event creation and forces the PIN flow even for the very first session.
- **`gracefulShutdown` flushes everything.** New in-memory caches that need to survive restart must be persisted there (and at suitable mutation points), not just in `saveDb()`.
- **Web Push is opt-in.** Without `WEB_PUSH_PUBLIC_KEY` and `WEB_PUSH_PRIVATE_KEY`, push routes return 503 and `/api/health.webPushEnabled` is false. Generate VAPID keys with `npx web-push generate-vapid-keys`.

## Environment

Required: `OPENAI_API_KEY` (without it, the app runs in fallback UI-only mode — translations return empty). Optional but commonly set: `OPENAI_MODEL=gpt-4.1-nano`, `OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`, `SPEECH_PROVIDER`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `MASTER_ADMIN_PIN`, `MAIN_OPERATOR_PIN`, `ADMIN_SESSION_SECRET`, `PUBLIC_BASE_URL`, `ADMIN_APP_BASE_URL`, `ADMIN_APP_HOSTNAMES`, `COMMERCIAL_MODE`, `WEB_PUSH_*`, `LOG_DIR`, `DATA_DIR`, `PORT`. See `.env.example` and `README.md` for the full list with defaults.

## Deployment

Render Web Service: build `npm install`, start `npm start`, health check `/api/health`. `render.yaml` is committed but not required if deploying via the Render UI.
