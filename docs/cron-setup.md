# External Cron Setup

Vercel Hobby limits crons to once daily. Use cron-job.org (free) to hit
`/api/cron-notify` as frequently as every 5 minutes.

## cron-job.org

1. Create a free account at https://cron-job.org
2. Dashboard → **Create cronjob**
3. **URL**: `https://<your-vercel-domain>/api/cron-notify?secret=<CRON_SECRET>`
4. **Schedule**: every 5 minutes (or your preferred interval)
5. **Method**: GET
6. Save — done.

The `?secret=` query param is accepted alongside the `Authorization: Bearer`
header. Both methods are equivalent.

## Environment variable

Set `CRON_SECRET` in Vercel → Project → Settings → Environment Variables.
Use a random 32-char string (e.g. `openssl rand -hex 16`).

If `CRON_SECRET` is not set, the endpoint is open — fine for local dev,
not recommended in production.

## Overlap protection

The handler uses a DB-backed lock (`monitor_state` table) with a 4-minute
window. If two invocations fire within 4 minutes of each other, the second
one returns `{ ok: true, skipped: true, reason: "overlap" }` immediately.
This makes 5-minute external crons safe even if they occasionally fire early.

## Vercel fallback

`vercel.json` keeps `0 0 * * *` (midnight UTC daily) as a fallback cron.
The overlap lock ensures no double-processing if both fire close together.

## Response shape

```json
{
  "ok": true,
  "ts": "2026-05-19T00:00:00.000Z",
  "duration_ms": 1234,
  "reminders": 2,
  "live_alerts": 1,
  "monitor_alerted": 5,
  "errors": []
}
```

`errors` is omitted when empty.
