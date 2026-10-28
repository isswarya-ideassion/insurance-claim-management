# HarborPoint Claims Operations Hub

A full-stack insurance claims management application for the fictional **HarborPoint General Insurance**. It implements the Enterprise Claims Operations Hub PRD: the complete claim lifecycle — FNOL, coverage verification, triage and assignment, document intake, evaluation, reserves with an authority decision node, compliance review, settlement approval, payment issuance, closure and recovery — with role-based workspaces for eight roles (the PRD's seven plus a Claims Operations Manager who owns every new claim), SLA clocks, segment configuration with four-eyes approval, field-level encryption, a hash-chained audit trail, centralized customer records and Claude-assisted automation.

- **Frontend:** React 19 + Vite 8 (JavaScript `.js` files only), Tailwind CSS 4, shadcn/ui-style components on Radix UI, Lucide icons, React Router 7, React Hook Form + Zod, Recharts, Framer Motion
- **Backend:** Node.js + Express 5 REST API (`/api/v1`), Zod validation, centralized error handling and request logging
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

Open http://localhost:5173 and sign in with any demo account (password `HarborDemo!2026`). With demo data the login page has one-click buttons for each role and a yellow **DEMO DATA** banner is shown.

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

For real data set `FIELD_ENCRYPTION_KEY` (32 random bytes, base64) and keep `SEED_DEMO_DATA=false`; see [docs/SETUP.md](docs/SETUP.md). An existing Supabase project moves over with `npm run db:import-supabase` (users keep their passwords; documents are copied into the database).

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
| `npm run db:migrate` / `npm run db:status` | Apply / list database migrations (`database/migrations`) |
| `npm run db:seed-demo` | Load the fictional demo data into a **development** database |
| `npm run db:import-supabase` | One-time copy of a Supabase project into an empty PostgreSQL database |
| `npm run db:transitions-sql` | Regenerate the workflow-transition migration from `shared/workflow.js` |

## Project layout

```text
client/            React app (pages per role, shared components, services, hooks, schemas)
server/            Express API (modules: auth, policies, claims, documents, assignments, tasks,
                   evaluations, reserves, settlements, compliance, payments, closure, config,
                   integrations, customers, automation, notifications, reports, audit, admin),
                   db layer, services (workflow, SLA, authority, crypto, config), seed data, tests
shared/            Business rules used by both sides: roles, statuses, workflow transitions, permissions
database/          SQL migrations and reference seed
docs/              PRD, API, database and setup guides
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

## Documentation

- [docs/PRD.md](docs/PRD.md) — product requirements, roles, workflow (as built)
- [docs/PRD-enterprise-hub.md](docs/PRD-enterprise-hub.md) — Enterprise Claims Operations Hub PRD v1.3 (roles, routing to the Claims Operations Manager, implemented schema), with implementation status
- [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md) — end-to-end code walkthrough: structure, modules, database, AI, security, API flows, run and test
- [docs/API.md](docs/API.md) — endpoints with request/response examples
- [docs/DATABASE.md](docs/DATABASE.md) — tables, relationships, constraints, RLS
- [docs/DEPLOY-VERCEL.md](docs/DEPLOY-VERCEL.md) — deploying to Vercel with Neon and a hosted Ollama
- [docs/DATABASE-REFERENCE.md](docs/DATABASE-REFERENCE.md) — every table: columns, keys, joins, usage by module, sample queries, ERD and workflow
- [docs/SETUP.md](docs/SETUP.md) — PostgreSQL setup, configuration, migrations, Supabase import, tests, demo accounts, UAT script
