# Operations — health, logs, uptime, deploy alerts

## Health endpoint

`GET /api/health` returns JSON (no auth) with, among other fields:

- `version`, `uptimeSeconds`
- `dbFile` — absolute path of the JSON store (`sessions.json`)
- `diskFreePercent` — free space on the data disk, as a percentage
- `openai.configured`, `azureSpeechConfigured`, `webPushEnabled` — booleans only
  (never the keys themselves)
- `activeEvents`, `connectedParticipants`

Use it as the Render health check path and for external uptime monitoring.

## Structured request logs

Every `/api/*` and page request is written to the app log (`LOG_DIR/app.log`,
rotated at 5 MB, 3 archives) as a single JSON line:

```json
{"ts":"2026-09-29T15:00:00.000Z","level":"REQ","id":"lz1a-3f","method":"POST","route":"/api/events","status":200,"ms":12}
```

The same request id is returned in the `x-request-id` response header, so a
client-side error can be tied to a server log line. Static asset requests are
not logged (signal over noise).

## Graceful shutdown

On `SIGTERM`/`SIGINT` (Render sends `SIGTERM` on every deploy) the server:
closes Azure speech sessions, flushes the translation cache, calls `saveDb()`
to flush the JSON store, disconnects sockets, and closes the HTTP server —
with a 10 s force-exit safety timer. This means a deploy never cuts a store
write in half.

## Free uptime monitor (recommended)

Point a free monitor at `https://<your-domain>/api/health` every 1–5 minutes:

- **UptimeRobot** (free tier): add an HTTP(s) monitor, URL = the health path,
  keyword monitoring on `"ok":true`. Alerts by email/Slack/Telegram.
- **BetterStack / Hyperping / Cronitor** free tiers work the same way.

Alert if the check fails twice in a row (avoids flapping during a deploy, which
lasts only a few seconds).

## Render deploy alerts

In the Render dashboard:

1. **Service → Settings → Notifications** — enable deploy + failure
   notifications (email, or a Slack webhook).
2. **Service → Settings → Health Check Path** = `/api/health` so Render waits
   for a healthy boot before switching traffic to a new deploy.
3. Optional: **Notifications → Slack** for deploy-started / deploy-live /
   deploy-failed events.

With the health check path set, a bad deploy is rolled back automatically
instead of taking the live service down.
