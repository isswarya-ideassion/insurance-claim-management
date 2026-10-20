# HarborPoint Claims Operations Hub

A full-stack insurance claims management application for the fictional **HarborPoint General Insurance**. It covers the complete claim lifecycle — customer submission, intake and policy verification, document review, investigation and loss assessment, reserve approval, compliance review, settlement approval, payment and closure — with role-based workspaces for ten roles, centralized customer records, and AI-assisted automation for claims officers.

- **Frontend:** React 19 + Vite 8 (JavaScript `.js` files only), Tailwind CSS 4, shadcn/ui-style components on Radix UI, Lucide icons, React Router 7, React Hook Form + Zod, Recharts, Framer Motion
- **Backend:** Node.js + Express 5 REST API (`/api/v1`), Zod validation, centralized error handling and request logging
- **Data:** Supabase PostgreSQL (migrations, constraints, triggers, row-level security), Supabase Auth, private Supabase Storage bucket
- **Mock mode:** a clearly labelled local demo that runs the *same* SQL migrations on embedded PGlite, with demo logins, local file storage and a simulated payment adapter — no credentials required

> Payments are always processed by a **simulated adapter** in this MVP. No money is moved; references start with `SIM-`.

## Quick start (mock mode — no Supabase needed)

Requirements: Node.js **20.19+**.

```bash
npm install          # installs client + server workspaces
npm run dev          # API on http://localhost:4000, web app on http://localhost:5173
```

Open http://localhost:5173 and sign in with any demo account (password `HarborDemo!2026`). The login page has one-click buttons for each role. A yellow **MOCK MODE** banner is always shown.

| Role | Email |
|---|---|
| Customer | `customer.alice@demo.harborpoint.test` (also `customer.ben`, `customer.chen`) |
| Claims Operations | `ops.olivia@demo.harborpoint.test` |
| Document Reviewer | `reviewer.raj@demo.harborpoint.test` |
| Claims Adjuster | `adjuster.adam@demo.harborpoint.test`, `adjuster.amara@…` |
| Claims Manager (limit $50k) | `manager.maria@demo.harborpoint.test` |
| Claims Manager (limit $250k) + Operations | `manager.sam@demo.harborpoint.test` |
| Payment Operations | `payments.priya@demo.harborpoint.test` |
| Compliance Officer | `compliance.carlos@demo.harborpoint.test` |
| Data Administrator | `admin.dana@demo.harborpoint.test` |
| Auditor | `auditor.ade@demo.harborpoint.test` |
| Customer Records Admin | `records.rosa@demo.harborpoint.test` |

Mock data persists in `server/.data/` (gitignored). Delete that folder to reset the demo, or set `MOCK_DB_PERSISTENCE=memory`.

To run against a real Supabase project, follow [docs/SETUP.md](docs/SETUP.md).

## AI automation

Claims officers get document extraction, missing-document checks, claim summaries and deadline reminders on each claim's **Automation** tab and on the **Reminders** page. Missing-document checks and reminders are rule-based and always work. Extraction and summaries need an AI provider, configured on the server only:

```bash
# server/.env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=<your key>
# optional: AI_MODEL=claude-opus-5-5  AI_TIMEOUT_MS=90000  AI_MAX_RETRIES=2
```

Without a provider (`AI_PROVIDER=none`, the default) the app shows these setup instructions instead of results. It never shows placeholder AI output. AI suggestions are always labeled, and saving an extracted value needs explicit confirmation by an authorized user.

## Scripts (run from the repository root)

| Command | Purpose |
|---|---|
| `npm run dev` | Run API and web app together |
| `npm run dev:server` / `npm run dev:client` | Run one side only |
| `npm run build` | Production build of the web app (`client/dist`) |
| `npm start` | Start the API without file watching |
| `npm test` | Server (unit, integration, RLS, end-to-end) and client tests |
| `npm run lint` | Syntax + import-resolution checks for both workspaces |
| `npm run provision:dev` | Create demo users and data in a **development** Supabase project |
| `npm run db:transitions-sql` | Regenerate the workflow-transition migration from `shared/workflow.js` |

## Project layout

```text
client/            React app (pages per role, shared components, services, hooks, schemas)
server/            Express API (modules: auth, policies, claims, documents, assignments, tasks,
                   assessments, reserves, approvals, compliance, payments, notifications, reports,
                   audit, admin), db layer, services, seed data, tests
shared/            Business rules used by both sides: roles, statuses, workflow transitions, permissions
supabase/          SQL migrations, reference seed, Supabase CLI config
docs/              PRD, API, database and setup guides
```

## Security model in brief

- Authorization is enforced in the API on every endpoint (role permissions, claim scope, ownership, conflict-of-interest checks) **and** in the database (RLS policies, CHECK constraints, triggers for status transitions, approval authority, payment state machine, immutable audit records).
- The service-role key exists only on the server. The browser receives only the Supabase anon key.
- Self-registration grants only the `CUSTOMER` role; staff roles are granted by a data administrator, who can never change their own roles.
- Documents live in a private bucket and are streamed through the API after an access check — there are no public URLs.
- Mock mode refuses to start with `NODE_ENV=production`, and the app never falls back to mock authentication when Supabase authentication fails.
- Customer records are visible to one designated role (`CUSTOMER_RECORDS_ADMIN`), enforced by API permissions and RLS; every view, export and download is audited.
- AI keys live only in `server/.env`. AI output is validated, labeled and never applied without human confirmation; AI cannot approve, reject or settle claims.

## Documentation

- [docs/PRD.md](docs/PRD.md) — product requirements, roles, workflow
- [docs/API.md](docs/API.md) — endpoints with request/response examples
- [docs/DATABASE.md](docs/DATABASE.md) — tables, relationships, constraints, RLS
- [docs/SETUP.md](docs/SETUP.md) — Supabase setup, migrations, storage, environment, test accounts, UAT script
