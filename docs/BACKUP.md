# Automatic backup (S3-compatible)

Sanctuary Voice can copy its JSON store nightly to any S3-compatible bucket
(Cloudflare R2, Backblaze B2, MinIO, AWS S3). The feature is **off by default**
and turns on only when the `BACKUP_S3_*` env vars are present — no AWS SDK is
used, requests are signed in-house with AWS Signature V4.

## What is backed up

- `sessions.json` (the store — always)
- `translation-cache.json` (if present)
- everything under `DATA_DIR/uploads/` (if present)

Audio archives are **not** included (they are large and reproducible).

## Enable it

Set these env vars on the service (Render → Environment):

| Variable | Required | Example |
| --- | --- | --- |
| `BACKUP_S3_ENDPOINT` | yes | `https://<account>.r2.cloudflarestorage.com` |
| `BACKUP_S3_BUCKET` | yes | `sanctuary-backups` |
| `BACKUP_S3_ACCESS_KEY_ID` | yes | R2/B2 access key id |
| `BACKUP_S3_SECRET_ACCESS_KEY` | yes | R2/B2 secret |
| `BACKUP_S3_REGION` | no | `auto` (R2 default); `us-east-1` for AWS |
| `BACKUP_S3_PREFIX` | no | `sanctuary-voice` (key prefix) |
| `BACKUP_HOUR_UTC` | no | `3` (nightly run hour, UTC) |

### Cloudflare R2

1. R2 → Create bucket.
2. R2 → Manage API Tokens → create a token with Object Read & Write for the
   bucket. Use the S3 endpoint `https://<account_id>.r2.cloudflarestorage.com`,
   region `auto`.

### Backblaze B2

1. Create a bucket, then an application key scoped to it.
2. Endpoint is the bucket's S3 endpoint, e.g.
   `https://s3.us-west-004.backblazeb2.com`, region e.g. `us-west-004`.

## Layout and rotation

```
<prefix>/daily/YYYY-MM-DD/sessions.json
<prefix>/weekly/YYYY-Www/sessions.json   (a copy taken on Sundays)
```

Rotation keeps **14 daily** folders and **8 weekly** folders; older folders are
deleted after each run.

## Seeing the last backup

`GET /api/health` includes:

```json
"autoBackup": { "configured": true, "lastAt": "2026-09-29T03:00:12.000Z", "ok": true, "error": null }
```

The admin UI reads this, so the last automatic backup shows in Settings.

## Restore

Download the objects from the most recent `daily/` (or `weekly/`) folder and
copy `sessions.json` into `DATA_DIR`, then restart the service. That's it — the
store is a single JSON file.

## Test locally

```bash
npm run test:backup   # mock S3 over HTTP, no network, no credentials
```
