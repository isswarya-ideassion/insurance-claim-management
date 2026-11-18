# HarborPoint Claims Operations Hub

A full-stack insurance claims management application for the fictional **HarborPoint General Insurance**. It implements the Enterprise Claims Operations Hub PRD: the complete claim lifecycle — FNOL, coverage verification, triage and assignment, document intake, evaluation, reserves with an authority decision node, compliance review, settlement approval, payment issuance, closure and recovery — with role-based workspaces for eight roles (the PRD's seven plus a Claims Operations Manager who owns every new claim), SLA clocks, segment configuration with four-eyes approval, field-level encryption, a hash-chained audit trail, centralized customer records and Claude-assisted automation.

- **Frontend:** React 19 + Vite 8 (JavaScript `.js` files only), Tailwind CSS 4, shadcn/ui-style components on Radix UI, Lucide icons, React Router 7, React Hook Form + Zod, Recharts, Framer Motion
- **Backend:** Node.js + Express 5 REST API (`/api`), Zod validation, centralized error handling and request logging
- **Data:** PostgreSQL only — schema with migrations, constraints, triggers and row-level security; the API's own email + password sign-in (`auth.users`, scrypt hashes, signed session tokens); claim documents stored in the database (`document_files`)
- **Demo data:** optional fictional users, policies and claims (`SEED_DEMO_DATA=true`) with one-click logins and a simulated payment adapter

> Payments are always processed by a **simulated adapter** in this MVP. No money is moved; references start with `SIM-`.

## Quick start

Requirements: Node.js **20.19+** and a PostgreSQL **14+** server (for example `docker run -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=harborpoint -p 5432:5432 -d postgres:17`).

```bash
npm install                          # installs client + server workspaces
cp server/.env.example server/.env   # set DATABASE_URL and AUTH_TOKEN_SECRET; SEED_DEMO_DATA=true for the demo
npm run dev                          # migrates the database, then API on :4000 and web app on :5173
```

Open http://localhost:5173 and sign in with any demo account (password `HarborDemo!2026`). With demo data the login page has a **Quick role switch** list that signs in as any role in one step.

| Role | Email |
|---|---|
| Client | `customer.alice@demo.harborpoint.test` (also `customer.ben`, `customer.chen`) |
| Claims Operations Manager | `ops.olivia@demo.harborpoint.test`, `ops.omar@…` (new claims are routed to them automatically) |
| Claims Manager | `manager.maria@…` ($50k authority), `manager.sam@…` ($250k) |
| Adjuster | `adjuster.adam@demo.harborpoint.test`, `adjuster.amara@…` |
| Document Reviewer | `reviewer.raj@demo.harborpoint.test` |
| Payment Operator | `payments.priya@demo.harborpoint.test`, `payments.paul@…` |
| Data Engineer | `data.dana@demo.harborpoint.test` |
| Compliance & Security | `compliance.carlos@demo.harborpoint.test`; `records.rosa@…` (*Customer Records* button) |

To reset the demo, drop and recreate the database; the next start migrates and seeds it again.

For real data set `FIELD_ENCRYPTION_KEY` (32 random bytes, base64) and keep `SEED_DEMO_DATA=false` (see [Configuration](#configuration)). An existing Supabase project moves over with `npm run db:import-supabase` (users keep their passwords; documents are copied into the database).

## Configuration

All settings live in `server/.env` (start from `server/.env.example`). The server validates them on start and refuses to run without `DATABASE_URL` and `AUTH_TOKEN_SECRET`, or without `FIELD_ENCRYPTION_KEY` outside demo and test databases.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | **Required.** `postgresql://harborpoint:<password>@localhost:5432/harborpoint` |
| `DATABASE_SSL` | `disable` (local), `require`, or `verify-full` (use for managed databases) |
| `AUTH_TOKEN_SECRET` | **Required.** At least 32 random characters; signs session tokens |
| `FIELD_ENCRYPTION_KEY` | **Required for real data.** 32 random bytes (base64 or 64 hex) for AES-256-GCM encryption of bank details and claimant contacts. Losing it makes those fields unreadable |
| `SEED_DEMO_DATA` | `true` creates fictional demo users, policies and claims on start (refused with `NODE_ENV=production`) |
| `DB_MIGRATE_ON_START` | Apply pending migrations at start (default `true`; set `false` when a pipeline migrates) |
| `AI_PROVIDER` | `beacon` (built-in rules, no network call), `anthropic`, `ollama` or `none` |
| `CLIENT_ORIGIN` | Allowed browser origin(s), comma-separated |
| `MAX_UPLOAD_MB` | Largest upload, 1–10 MB (default 10; 4 on Vercel) |

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. The web app needs no configuration: `client/.env` only has `VITE_API_URL` (default `/api`, proxied by Vite to port 4000).

## Database and migrations

```bash
npm run db:migrate      # apply server/src/db/migrations in order (also done automatically at API start)
npm run db:status       # list applied and pending migrations
npm run db:seed-demo    # optional, development only: demo users, policies and claims
```

Migrations are plain SQL files in `server/src/db/migrations/`, applied in filename order, each in its own transaction, and recorded in `app_meta.schema_migrations`; an advisory lock lets several API instances start together. `server/src/db/seed.sql` (the reference roles) is re-applied after them and is idempotent. If you change `shared/workflow.js`, regenerate the transition migration with `npm run db:transitions-sql` and ship it as a new migration.

Self-registration creates a `CLIENT` account. Staff accounts are created by Compliance & Security under **Users & roles → Create user**. On an empty non-production database, `npm run db:seed-demo` provides the first Compliance & Security user.

## Tests and checks

The server tests need a PostgreSQL server where the test user may create databases (a local superuser is simplest). One template database is migrated and seeded per run, and each test file gets its own clone.

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm test
npm run lint      # syntax and import-resolution checks
npm run build     # production web build
```

## Deploying to Vercel

`vercel.json` builds the web app to `client/dist` and serves the API from `api/index.js` as one function. On Vercel, migrations never run on a request, scheduled jobs run through Vercel Cron (`/api/internal/cron/jobs`), uploads are capped at 4 MB and each instance keeps a pool of 3 connections; `api/index.js` applies these defaults.

1. Create a PostgreSQL database (for example Neon, in the region closest to `"regions"` in `vercel.json`).
2. From your machine, with the database's **direct** (unpooled) connection string: `DATABASE_URL=<url> DATABASE_SSL=require npm run db:migrate` (and `npm run db:seed-demo` for a demo). Repeat `db:migrate` before deploying any release that adds a migration.
3. In Vercel → Settings → Environment Variables set `NODE_ENV=production`, `DATABASE_URL` (pooled string), `DATABASE_SSL=require`, `AUTH_TOKEN_SECRET`, `FIELD_ENCRYPTION_KEY` (the **same** key used when seeding), `CLIENT_ORIGIN`, `CRON_SECRET` and `AI_PROVIDER=beacon`. Never commit them.
4. Deploy, then open `/api/health` and check `"database"` and `"aiConfigured"`.

## Production notes

- Run with `NODE_ENV=production`, `SEED_DEMO_DATA=false`, `DATABASE_SSL=verify-full` for a remote database, and secrets from a secrets manager.
- Back up with point-in-time recovery or `pg_dump`; backups include the claim documents (`public.document_files`). Store the encryption key separately from the backups.
- Add a real email provider by implementing `send()` in `server/src/services/email.service.js`, and a real payment provider by implementing `initiateTransfer()` in place of the simulated adapter.

## AI automation

Claims Operations Managers, Claims Managers and Document Reviewers get document extraction, missing-document checks, claim summaries and deadline reminders on each claim's **Automation** tab and on the **Reminders** page. Missing-document checks and reminders are rule-based and always work. Extraction and summaries need an AI provider, configured on the server only:

```bash
# server/.env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=<your key>
# optional: AI_MODEL=claude-opus-5-5  AI_TIMEOUT_MS=90000  AI_MAX_RETRIES=2
```

Without a provider (`AI_PROVIDER=none`, the default) the app shows these setup instructions instead of results. It never shows placeholder AI output. AI suggestions are always labeled with a 0–1 confidence, every run is recorded in `ai_runs` and audited as an agent action, and saving an extracted value needs explicit confirmation by an authorized user.

## Scripts (run from the repository root)

| Command | Purpose |
|---|---|
| `npm run dev` | Run API and web app together |
| `npm run dev:server` / `npm run dev:client` | Run one side only |
| `npm run build` | Production build of the web app (`client/dist`) |
| `npm start` | Start the API without file watching |
| `npm test` | Server (unit, integration, RLS, end-to-end; needs `TEST_DATABASE_URL`) and client tests |
| `npm run lint` | Syntax + import-resolution checks for both workspaces |
| `npm run db:migrate` / `npm run db:status` | Apply / list database migrations (`server/src/db/migrations`) |
| `npm run db:seed-demo` | Load the fictional demo data into a **development** database |
| `npm run db:import-supabase` | One-time copy of a Supabase project into an empty PostgreSQL database |
| `npm run db:transitions-sql` | Regenerate the workflow-transition migration from `shared/workflow.js` |

## Project layout

```text
client/            Frontend: React app (pages per role, shared components, services, hooks, schemas)
server/            Backend: Express API (modules: auth, policies, claims, documents, assignments, tasks,
                   evaluations, reserves, settlements, compliance, payments, closure, config,
                   integrations, customers, automation, notifications, reports, audit, admin),
                   services (workflow, SLA, authority, crypto, config, Beacon intelligence),
                   seed data, tests
  src/db/          Database layer: query builder, migration runner, SQL migrations and reference seed
shared/            Business rules used by both sides: roles, statuses, workflow transitions, permissions
api/               Vercel Function entry that serves the Express API
```

## Security model in brief

- Authorization is enforced in the API on every endpoint (role permissions, claim scope, ownership, conflict-of-interest checks) **and** in the database (RLS policies, CHECK constraints, triggers for status transitions, approval authority, payment state machine, immutable audit records).
- All secrets (database password, `AUTH_TOKEN_SECRET`, `FIELD_ENCRYPTION_KEY`, AI key) exist only on the server. Passwords are stored as scrypt hashes; sign-in is rate-limited and does not reveal whether an account exists.
- Self-registration grants only the `CLIENT` role and requires accepting the privacy notice; staff roles and authority overrides are granted by Compliance & Security, who can never change their own.
- Monetary authority comes from `authority_limits` (by role and segment) and per-user overrides. Preparer ≠ approver, approver ≠ issuer and bank-detail changer ≠ payee verifier are enforced in the API and by database triggers.
- Bank details and claimant contacts are encrypted with AES-256-GCM; the audit log is append-only and hash-chained, with a verification endpoint.
- Documents are stored write-once in PostgreSQL with a SHA-256 integrity check and streamed through the API after an access check — there are no public URLs.
- Demo data is refused with `NODE_ENV=production`.
- Customer records are visible to Compliance & Security only, enforced by API permissions and RLS; every view, export and download is audited.
- AI keys live only in `server/.env`. AI output is validated, labeled and never applied without human confirmation; AI cannot approve, reject or settle claims.
