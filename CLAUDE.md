# HarborPoint Claims Operations Hub

Insurance claims app: React client + Express API + PostgreSQL. npm workspaces (`client`, `server`); Node >= 20.19. Full docs in README.md.

## Layout

| Path | What |
|---|---|
| `client/` | React 19, Vite 8, Tailwind 4, Radix, React Router 7, RHF + Zod. **`.js` files only** (no `.jsx`/TS; enforced by lint) |
| `client/src/` | `pages/<role>/`, `components/`, `services/` (API calls), `schemas/`, `hooks/`, `context/`, `test/` |
| `server/src/` | Express 5 API under `/api`. `modules/<domain>/` (claims, documents, payments, reserves, ...), `services/`, `middleware/`, `routes/` |
| `server/src/db/` | `migrations/*.sql` (applied in filename order), `seed.sql` (idempotent, re-applied), `repository.js`, `migrate.js` |
| `server/tests/` | `unit/`, `integration/` (Vitest + supertest), `global-setup.js`, `test-db.js` |
| `shared/` | Shared by client and server: `constants.js` (statuses, roles), `permissions.js`, `workflow.js` |
| `api/index.js` | Vercel entry point; loads `server/src/serverless.js` |

Import aliases in client: `@/` -> `client/src/`, `@shared/` -> `shared/`.

## Commands (run from repo root)

```bash
npm run dev            # migrate, then API :4000 + web :5173
npm run lint           # server check-syntax.js + client check-imports.js
npm run build          # client production build
npm test               # server + client (server needs TEST_DATABASE_URL)
npm run test:server    # Vitest; clones a migrated template DB per test file
npm run test:client    # Vitest + jsdom + Testing Library
npx vitest run tests/unit/workflow.rules.test.js   # single file (run inside server/)
```

Server tests need a Postgres user allowed to create databases, e.g.
`TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres`.

## Database scripts

| Script | Purpose |
|---|---|
| `db:migrate` / `db:status` | Apply / list migrations (also auto-run on API start unless `DB_MIGRATE_ON_START=false`) |
| `db:seed-demo` | Fictional demo users/policies/claims (dev only; refused in production) |
| `db:seed-e2e` | E2E demo seed (`server/scripts/seed-e2e.js`) |
| `db:transitions-sql` | Regenerate transition SQL from `shared/workflow.js` |
| `db:import-supabase` | One-time copy of a Supabase project into empty Postgres |

Never edit an applied migration; add a new timestamped file in `server/src/db/migrations/`.

## Claim workflow (`shared/workflow.js`)

Single source of truth for claim status transitions. Each entry in `TRANSITIONS`:
`{ from, to, roles, guards?, requiresReason?, systemOnly?, closure?, label }`.

- **Main path:** DRAFT -> SUBMITTED -> POLICY_VERIFICATION -> DOCUMENTS_REQUIRED <-> DOCUMENT_REVIEW
  -> ADJUSTER_ASSIGNMENT -> INVESTIGATION -> (RESERVE_APPROVAL if over adjuster authority) -> COMPLIANCE_REVIEW
  -> SETTLEMENT_APPROVAL -> PAYMENT_PENDING -> PAID (or PAYMENT_FAILED -> retry) -> CLOSED.
- **Side exits:** REJECTED (manager, reason required), WITHDRAWN (client), ON_HOLD (from any `HOLDABLE_STATUSES`; resume returns to the held status).
- **Reopen:** REJECTED/CLOSED -> REOPENED -> POLICY_VERIFICATION | DOCUMENT_REVIEW | INVESTIGATION (manager only).
- **Closure:** `COMPLETED` requires all obligations met; `PERMITTED_OUTCOME` (rejected/withdrawn) cancels open work.
- **Guards** are named strings (`GUARD_DESCRIPTIONS`), evaluated in `server/src/services/workflow.service.js`.
- `PAYMENT_PENDING -> PAID/PAYMENT_FAILED` are `systemOnly` (payment service, simulated adapter, refs start `SIM-`).

**When changing `workflow.js`:** update the guard in `workflow.service.js`, run `npm run db:transitions-sql`,
ship the output as a new migration, and update `server/tests/unit/workflow.rules.test.js` / `integration/workflow.test.js`.

## Roles (`shared/constants.js` `ROLES`)

CLIENT, CLAIMS_OPS_MANAGER (owns new claims/intake), OPS_MANAGER (Claims Manager: approve/deny/close/reopen),
DOCUMENT_REVIEWER, ADJUSTER, PAYMENT_OPERATOR, DATA_ENGINEER, COMPLIANCE_SECURITY.

## Conventions

- ES modules everywhere (`"type": "module"`). Validate inputs with Zod at API boundaries.
- Secrets live in `server/.env` (never commit, never edit via Claude). `client/.env` only has `VITE_API_URL`.
- Sensitive fields (bank details, contacts) are AES-256-GCM encrypted; audit trail is hash-chained, so don't bypass `audit.service.js`.
- AI provider is server-only (`AI_PROVIDER`: beacon | anthropic | ollama | none).
- `docs/` is gitignored (local internal docs).
- Run `npm run lint` and the relevant tests before calling a change done.
