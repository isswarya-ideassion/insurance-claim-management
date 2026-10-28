# Deploying to Vercel with Neon and Ollama

The whole application runs in one Vercel project:

| Part | Where it runs |
|---|---|
| React client | Vercel static hosting (`client/dist`) |
| Express API | One Vercel Function, `api/index.js`; all of `/api/v1/*` is rewritten to it (`vercel.json`) |
| PostgreSQL | Neon, connected through the Vercel Marketplace |
| Scheduled jobs | Vercel Cron calls `GET /api/v1/internal/cron/jobs` |
| AI agents | An Ollama server reachable over HTTPS (Ollama cannot run inside Vercel) |

Your laptop's database and Ollama are not reachable from Vercel; this guide moves both.

## How the Vercel version differs from running locally

| Concern | Local (`npm run dev`) | Vercel |
|---|---|---|
| Migrations | Run when the API starts | Run as a deploy step (step 3); never on a request |
| Scheduled jobs (overdue tasks, SLA escalation, reminders, audit partitions) | Every 15 minutes inside the server | Vercel Cron; daily on the Hobby plan (see step 7) |
| Upload size | 10 MB | 4 MB (Vercel accepts requests up to 4.5 MB) |
| Database connections | Pool of 10 | Pool of 3 per function instance, through Neon's pooler |
| AI | Ollama on `localhost` | Ollama on a server with a public HTTPS address and a key |

`api/index.js` applies these defaults; you do not need to set them.

## 1. Create the database (Neon)

1. Create a Neon project (in the Neon console, or in Vercel under **Storage → Create Database → Neon**) with only **Postgres database** enabled: documents are stored in PostgreSQL, so object storage and Neon's other services are not needed. Choose the region **AWS Asia Pacific 1 (Singapore)**, which matches `"regions": ["sin1"]` in `vercel.json`. If you pick another region, change `regions` to the closest Vercel region.
2. Connect it to the Vercel project (Vercel → Storage → Connect, or copy the connection strings into the environment variables yourself). Use the pooled string for `DATABASE_URL`; keep the direct (unpooled) one for migrations.
   The free plan includes 1 GB of storage, which also holds the uploaded documents: enough for the demo, not for real volumes.
3. Copy the **unpooled** connection string for step 3 (Neon dashboard → Connection details, pooling off).

## 2. Choose the Ollama server

Vercel needs an Ollama it can reach over the internet. Choose one:

- **Ollama's hosted service (simplest).** Create an account and an API key at ollama.com. Use `OLLAMA_BASE_URL=https://ollama.com`, `OLLAMA_API_KEY=<key>` and a model offered there (`OLLAMA_MODEL`, for example `gpt-oss:20b`; check the current list of cloud models). Run one agent after deploying to confirm the model returns structured output.
- **Your own Ollama on a cloud server.** Install Ollama on a VM (a GPU makes runs much faster), pull the model, and publish it **only** behind an HTTPS reverse proxy that requires `Authorization: Bearer <key>` (for example Caddy or nginx). Never open port 11434 to the internet without authentication. Use `OLLAMA_BASE_URL=https://<your-host>`, `OLLAMA_API_KEY=<key>`, `OLLAMA_MODEL=llama3.1:8b`.

Ollama cannot read PDFs: field extraction works on image documents only (`OLLAMA_VISION_MODEL`). The six claim agents work on text and are unaffected.

## 3. Create the tables and load data (from your laptop)

Run from the `server` folder in PowerShell, with the **unpooled** Neon connection string. Your local `server/.env` still provides `FIELD_ENCRYPTION_KEY`; the variables set here take precedence over it.

```powershell
$env:DATABASE_URL = "<Neon unpooled connection string>"
$env:DATABASE_SSL = "require"
npm run db:migrate
npm run db:seed-demo     # optional: the fictional demo users, policies and claims
Remove-Item Env:DATABASE_URL, Env:DATABASE_SSL
```

- The demo data is encrypted with the `FIELD_ENCRYPTION_KEY` in your `server/.env`. Vercel **must use the same key** (step 4), or bank details and contact data cannot be read.
- Run `npm run db:migrate` the same way whenever a release adds a migration, before deploying it.
- To copy your existing local data instead of seeding, migrate first, then restore a data-only dump (`pg_dump --data-only`) with `pg_restore --data-only --disable-triggers`, using the same encryption key. Seeding is simpler for a demo.

## 4. Environment variables (Vercel → Project → Settings → Environment Variables)

Set these for **Production** (and Preview, if you use preview deployments). Never commit them to git.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon **pooled** string (added by the integration) |
| `DATABASE_SSL` | `require` |
| `AUTH_TOKEN_SECRET` | a new random secret, at least 32 characters |
| `FIELD_ENCRYPTION_KEY` | the **same** value as in your local `server/.env` (32 bytes, base64) |
| `CLIENT_ORIGIN` | your site address, for example `https://harborpoint.vercel.app` |
| `CRON_SECRET` | a random secret, at least 16 characters; Vercel Cron sends it automatically |
| `AI_PROVIDER` | `ollama` |
| `OLLAMA_BASE_URL` | the HTTPS address from step 2 |
| `OLLAMA_API_KEY` | the key from step 2 |
| `OLLAMA_MODEL` | the model from step 2 |
| `DEMO_PASSWORD` | only if you seeded with a password other than the default |

Generate a secret with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Leave `SEED_DEMO_DATA` unset: production refuses it, and the demo data was loaded in step 3.

## 5. Deploy

1. Push the repository to GitHub, then in Vercel: **Add New → Project → Import** the repository.
2. Root directory: the repository root (where `vercel.json` is). Framework preset: **Other**. Build and output settings come from `vercel.json`; leave them empty.
3. Deploy. Later pushes to the main branch deploy automatically.

## 6. Check the deployment

1. Open `https://<your-site>/api/v1/health`: expect `"status":"ok"` and `"aiConfigured":true`.
2. Sign in as `ops.olivia@demo.harborpoint.test` (password `HarborDemo!2026` unless changed).
3. Open `HPC-2026-000102` → *Policy & Coverage* → *Coverage check* → *Run*. The result line shows the Ollama model name.
4. Vercel → Project → **Logs** shows each request and `"msg":"ai run"` lines for agent runs.

## 7. Scheduled jobs

`vercel.json` schedules the jobs once a day (`0 3 * * *`, UTC), which every Vercel plan allows. The jobs are meant to run every 15 minutes, so on the Hobby plan SLA escalations and overdue-task notices would be up to a day late. Either:

- on a **Pro** plan, change the schedule to `*/15 * * * *` and redeploy; or
- use any external scheduler (GitHub Actions, cron-job.org) to call every 15 minutes:

```
GET https://<your-site>/api/v1/internal/cron/jobs
Authorization: Bearer <CRON_SECRET>
```

Without the secret the endpoint returns 401; with `CRON_SECRET` unset it returns 404.

## 8. Limits to know

- **Function duration.** `maxDuration` is 300 seconds, enough for local-model agent runs. If your plan allows less, lower it in `vercel.json`; a slow model may then time out.
- **Uploads** are limited to 4 MB on Vercel (`MAX_UPLOAD_MB`, set in `api/index.js` and in the client build command).
- **Rate limiting** of sign-in attempts is kept per function instance, so it is weaker than on a single server.
- **Payments and email** stay simulated (`EMAIL_ADAPTER=console` writes to the logs).
