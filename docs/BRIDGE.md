# worship-app ↔ Sanctuary Voice bridge (stage 8)

The **authoritative protocol** for the bridge. The worship-app side (PART B) must
match message names and payloads here exactly. Everything is additive on the SV
side; a non-bridged event behaves exactly as before.

## Model

- A worship-app event connects to **one** SV event with a short-lived
  **connection code** generated in SV (separate from the public participant code).
  worship-app exchanges it **server-to-server** for a **bridge token** scoped to
  that SV event, valid ~12h (practical cap), revocable from either side. Tokens are
  hashed at rest in SV; the plaintext is returned to worship-app exactly once.
- Phones and projector screens never talk to the other app. Only the two servers
  do (REST for the handshake, one Socket.IO connection for the live stream).
- One active bridge per SV event: a new exchange supersedes the previous one.

## REST (SV base URL, default https://sanctuaryvoice.com)

All JSON. SV-side generation/revocation needs an owner/operator session; the
server-to-server calls are authed by the code (exchange) or the token.

| Method & path | Auth | Body | Response |
|---|---|---|---|
| `POST /api/events/:id/bridge/code` | owner/operator session | — | `{ok, code, expiresAt, targetLanguages}` |
| `GET /api/events/:id/bridge/status` | owner/operator session | — | `{ok, connected, svEventId, eventName, targetLanguages, expiresAt, lastSeenAt, createdAt}` |
| `POST /api/events/:id/bridge/revoke` | owner/operator session | — | `{ok, connected:false, ...}` |
| `POST /api/bridge/exchange` | the code | `{code}` | `{ok, bridgeToken, svEventId, targetLanguages, expiresAt}` |
| `POST /api/bridge/revoke` | token | `{bridgeToken}` or `Authorization: Bearer <token>` | `{ok}` |
| `GET /api/bridge/status` | token (`Authorization: Bearer <token>` or `?token=`) | — | `{ok, connected:true, svEventId, targetLanguages, expiresAt, lastSeenAt}` (401 if inactive) |

- `code`: 6–8 chars, alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, 10 min, single use.
- Errors: exchange returns 400 `{ok:false, error}` with `invalid_code` /
  `code_used` / `code_expired`; the exchange endpoint is per-IP rate limited
  (429 `too_many_attempts`). Revoke/status with an unknown token → 404 / 401.

## Church pairing (one-time), then one-tap connections

Pair the church with worship-app **once**, then connect any event without a typed
code. The admin generates a one-time **pairing code** ("Împerechează worship-app",
same alphabet as the connection code); worship-app exchanges it server-to-server for
a **long-lived pairing token** scoped to the SV **organisation**, stored hashed at
rest (`db.bridgePairings`, additive), revocable from either side. The pairing token
then lists the org's events and connects any one of them — the connect returns
**exactly** the `/api/bridge/exchange` body, so everything after the handshake
(switches, `/bridge` socket, translation sources, `song.current`, `setlist.sections`)
is unchanged. The typed connection code stays as a fallback.

| Method & path | Auth | Body | Response |
|---|---|---|---|
| `POST /api/bridge/pair-code` | owner session | — | `{ok, code, expiresAt}` (admin generates the one-time pairing code) |
| `POST /api/bridge/pair` | the pairing code | `{code, churchName}` | `{ok, pairingToken, svOrgId, svOrgName, expiresAt:null}` |
| `GET /api/bridge/events` | pairing token (`Authorization: Bearer <pairingToken>` or `?token=`) | — | `{ok, events: [{svEventId, name, startsAt, status:'live'\|'planned', targetLanguages}]}` |
| `POST /api/bridge/connect` | pairing token | `{svEventId, worshipEventName}` | the same body as `/api/bridge/exchange`: `{ok, bridgeToken, svEventId, targetLanguages, expiresAt}` |
| `POST /api/bridge/unpair` | pairing token | — | `{ok}` |

- Pairing code: same format as the connection code (6–8 chars, 10 min, single use);
  `pair` returns 400 `invalid_code` / `code_used` / `code_expired` and is per-IP rate
  limited (429 `too_many_attempts`).
- The pairing token is long-lived (no expiry) and server-side only; SV logs a
  `token_fingerprint`, never the token. `GET /api/bridge/events` and
  `POST /api/bridge/connect` return 401 `unpaired` once the pairing is revoked;
  `connect` to an event outside the paired org (or hidden/unapproved) → 404
  `unknown_event`. `unpair` leaves open event bridges working until their own token
  expires or is revoked.
- SV may pair several worship churches with one organisation (one pairing row each).

## Socket.IO namespace `/bridge`

worship-app connects a **server-side** socket.io-client to `<svBaseUrl>/bridge`
with the token in the handshake:

```js
const socket = io(svBaseUrl + '/bridge', { auth: { token }, transports: ['websocket'] });
// (query ?token=<token> is also accepted)
```

An invalid / expired / revoked token → `connect_error`. On revoke or expiry SV
disconnects the socket. Reconnect with backoff; nothing else changes if it drops.

### SV → worship-app (translation stream, read-only)

Emitted only while a bridge socket is connected (no overhead otherwise). Mirrors
exactly what SV participants receive.

- `bridge.ready` — once on connect: `{ svEventId, targetLanguages: [..] }`
- `translation.partial` — in-progress, per language (throttled ~120 ms/lang):
  `{ entryId, sourceLang, original, createdAt, partial: true, translations: { <lang>: "<text>" } }`
- `translation.final` — the finished entry (replaces the partial with the same id):
  `{ id, sourceLang, original, translations: { <lang>: "<text>" }, createdAt, edited }`

worship-app offers this as the projector source **"Traducere · <limbă>"**, shown
only when the operator/leader picks it: render `translations[lang]` large for
`translation.final`, lighter for `translation.partial`.

### worship-app → SV (song sections, SV translates for its participants)

Sent by worship-app on the same socket:

- `song.current` — on every MAIN-position change to a song section:
  `{ title, label, text, hash, lang }`
  - `text`: section lyrics in the source language, **chords stripped** (lyrics only;
    transposition irrelevant).
  - `hash`: the section content hash (SV caches translations per hash).
  - `lang`: source language ISO code (e.g. `ro`). SV translates into the event's
    target languages (using the cache) and shows a **lyrics** card to participants.
- `song.clear` — when leaving songs (verse-only item / end / black): no payload.
- `setlist.sections` — on connect and on setlist change, all shared song sections
  so SV can pre-translate ahead (low priority, background):
  `[ { hash, text, title, label }, ... ]` (or `{ sections: [...] }`).

Throttle `song.current` to one message per position change.

### SV → participants (not part of the worship-app contract, for reference)

On `song.current` SV emits to its own participants `lyrics`
`{ eventId, hash, title, label, sourceLang, original, translations, createdAt }`,
and on `song.clear` `lyrics_clear { eventId }`. A late-joining participant gets the
current `lyrics` on join. Participants render it as a distinct card above the live
translation, in their chosen language.

## Switches & consent (worship-app side, both default off)

- "Afișează traducerea pe proiector" (dir_in) — enables the `translation` source.
- "Trimite cântările spre traducere" (dir_out) — enables `song.*` / `setlist.sections`;
  the church owner confirms once (lyrics may be copyrighted).

SV shows the connection state in the admin Live tab and lets the operator revoke.
If the bridge drops, both apps carry on alone; nothing switches source automatically.
