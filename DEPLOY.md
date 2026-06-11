# Deploying Holdfast

Holdfast is a **stateful** service — a long-running Fastify server with a pooled
Postgres connection and a background expiry sweeper. That fits a **persistent
container host** (Render / Railway / Fly), not a serverless platform. See the
note on Vercel at the bottom.

The image runs migrations on boot (`RUN_MIGRATIONS_ON_BOOT=true`), so a fresh DB
is set up automatically on first deploy.

---

## Option A — Render Blueprint (recommended, ~3 clicks, free)

`render.yaml` provisions the web service **and** a free Postgres, wiring
`DATABASE_URL` for you.

1. Push this repo to GitHub (done — `Shailesh93602/holdfast`).
2. Render → **New → Blueprint** → connect the `holdfast` repo → **Apply**.
3. Wait for the build; hit `https://holdfast-XXXX.onrender.com/healthz`.

Smoke test:
```bash
curl https://<your-app>.onrender.com/healthz
curl -XPOST https://<your-app>.onrender.com/reserve \
  -H 'content-type: application/json' -H 'idempotency-key: a1' \
  -d '{"sku":"MILK-1L","qty":1}'
```
(Seed demo SKUs first via the Render shell: `npm run seed`.)

## Option B — Railway (CLI, also free tier)
```bash
railway login
railway init           # create project
railway add            # add a PostgreSQL plugin
railway up             # deploy from the Dockerfile
# set RUN_MIGRATIONS_ON_BOOT=true and DATABASE_URL (Railway injects the PG URL)
```

## Option C — Fly.io
```bash
fly launch --no-deploy         # detects the Dockerfile
fly postgres create            # managed PG, then `fly postgres attach`
fly secrets set RUN_MIGRATIONS_ON_BOOT=true
fly deploy
```

---

## A note on Vercel
Vercel is serverless — a persistent server + pooled connections + a background
sweeper don't map to it cleanly. To run Holdfast on Vercel it would have to be
re-shaped into serverless functions (`api/*`), backed by a **serverless Postgres**
(Neon/Supabase pooled URL), with the sweeper moved to **Vercel Cron**. That's a
real refactor and arguably makes the design worse. If you specifically want the
`*.vercel.app` URL for the portfolio, say so and I'll do that adaptation on a
branch — otherwise Render/Railway is the right home for this service.
