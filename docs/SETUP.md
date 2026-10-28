# Setup Guide

The application runs on **PostgreSQL only**: the database, the sign-in credentials and the claim document files all live in one PostgreSQL database. No Supabase or other platform service is needed.

## 1. Prerequisites

- Node.js **20.19 or newer** and npm 10
- PostgreSQL **14 or newer** (local install, Docker, or a managed service such as Amazon RDS, Azure Database or Cloud SQL)

Install the application from the repository root:

```bash
npm install
```

## 2. Create the database

Create a database and a user that owns it. With `psql` as a superuser:

```sql
create user harborpoint with password 'choose-a-strong-password' createrole;
create database harborpoint owner harborpoint;
```

`CREATEROLE` is needed once, because the first migration creates the `anon` and `authenticated` roles that the row-level-security policies are written for. On managed services, use the provided admin user (for example `rds_superuser` members on RDS) for the first migration.

With Docker, for local development:

```bash
docker run --name harborpoint-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=harborpoint -p 5432:5432 -d postgres:17
```

## 3. Configure

```bash
cp server/.env.example server/.env
```

Set at least:

| Variable | Description |
|---|---|
| `DATABASE_URL` | **Required.** `postgresql://harborpoint:<password>@localhost:5432/harborpoint` |
| `DATABASE_SSL` | `disable` (local), `require` (encrypted) or `verify-full` (encrypted and certificate verified; use for managed services) |
| `AUTH_TOKEN_SECRET` | **Required.** At least 32 random characters; signs session tokens. `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `FIELD_ENCRYPTION_KEY` | **Required for real data.** 32 random bytes (base64 or 64 hex characters) for AES-256-GCM encryption of bank details and claimant contacts. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep it in a secrets manager; losing it makes those fields unreadable |
| `SEED_DEMO_DATA` | `true` creates fictional demo users, policies and claims on start (refused with `NODE_ENV=production`); demo databases may run without `FIELD_ENCRYPTION_KEY` |

Other server variables:

| Variable | Description |
|---|---|
| `NODE_ENV` | `development` / `test` / `production` |
| `PORT` | API port (default 4000) |
| `CLIENT_ORIGIN` | Allowed browser origin(s), comma-separated |
| `DATABASE_POOL_MAX` | Connections per API instance (default 10) |
| `DB_MIGRATE_ON_START` | Apply pending migrations at start (default `true`; set `false` if you migrate from a pipeline) |
| `AUTH_TOKEN_TTL_HOURS` | Session lifetime (default 8) |
| `DEMO_PASSWORD` | Password of every demo account (default `HarborDemo!2026`) |
| `EMAIL_ADAPTER` | `console` (logs only, including password-reset links) or `disabled` |
| `PAYMENT_ADAPTER` | `simulated` (only option in the MVP) |
| `OVERDUE_SWEEP_MINUTES` | Interval for the overdue-task, SLA-escalation and reminder sweeps; `0` disables |
| `AUTH_RATE_LIMIT` | Optional login/registration attempts per IP per 15 minutes |
| `AI_PROVIDER` | `none` (default — AI features show setup instructions), `ollama` (local models) or `anthropic` (Claude API) |
| `OLLAMA_API_KEY` | Bearer key for a hosted Ollama (ollama.com) or one behind an authenticating proxy. Empty for a local Ollama |
| `CRON_SECRET` | Enables `GET /api/v1/internal/cron/jobs` for an external scheduler such as Vercel Cron (see [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md)) |
| `MAX_UPLOAD_MB` | Largest upload, 1–10 MB (default 10; 4 on Vercel) |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` / `OLLAMA_VISION_MODEL` | With `AI_PROVIDER=ollama`: server address (default `http://localhost:11434`), text model (default `llama3.1:8b`) and the model used for image documents (default `llama3.2-vision`). Ollama cannot read PDFs; extraction of PDF documents needs `anthropic` or manual review |
| `ANTHROPIC_API_KEY` | **Server only.** Needed when `AI_PROVIDER=anthropic` |
| `AI_MODEL` | Default `claude-opus-5-5` |
| `AI_TIMEOUT_MS` / `AI_MAX_RETRIES` | Per-request timeout (default 90000) and retries for transient errors (default 2) |
| `REMINDER_LEAD_HOURS` | Claims due within this window get an "approaching deadline" reminder (default 24) |
| `CUSTOMER_RECORD_RETENTION_YEARS` | Retention period shown on customer records (default 7) |

The web app needs no configuration: `client/.env` only has `VITE_API_URL` (default `/api/v1`, proxied by Vite to port 4000).

The server validates its configuration on start and refuses to run without `DATABASE_URL` and `AUTH_TOKEN_SECRET`, or without `FIELD_ENCRYPTION_KEY` outside demo and test databases.

## 4. Migrate and run

```bash
npm run db:migrate      # apply database/migrations in order (also done automatically at API start)
npm run db:status       # list applied and pending migrations
npm run db:seed-demo    # optional, development only: demo users, policies and claims
npm run dev             # API on http://localhost:4000/api/v1, web app on http://localhost:5173
```

Migrations are plain SQL files in `database/migrations/`, applied in filename order inside a transaction each and recorded in `app_meta.schema_migrations`; an advisory lock lets several API instances start together. `database/seed.sql` (reference roles) is re-applied after them and is idempotent. If you change `shared/workflow.js`, regenerate the transition migration with `npm run db:transitions-sql` and ship it as a new migration.

Accounts: self-registration creates a `CLIENT` account (database trigger) and records the privacy-notice consent. Staff accounts are created by Compliance & Security under **Users & roles → Create user**. To create the very first Compliance & Security user on an empty database, run `npm run db:seed-demo` in a non-production database, or register an account and grant the role in SQL:

```sql
insert into public.user_roles (user_id, role_code)
select id, 'COMPLIANCE_SECURITY' from public.users where email = 'you@example.com';
```

### Demo data

With `SEED_DEMO_DATA=true` (or after `npm run db:seed-demo`) the database holds fictional data: 15 users across the eight roles, 7 policies, claims at every lifecycle stage, documents and artifact requirements, tasks, evaluations, reserve ledger entries, settlement approval steps, compliance reviews, payments, SLA clocks, a closure request, a recovery, integration runs and notifications. The web app shows a **DEMO DATA** banner and one-click demo logins. Password for every account: `HarborDemo!2026` (`DEMO_PASSWORD`).

| Role | Email | Notes |
|---|---|---|
| Client | `customer.alice@demo.harborpoint.test` | Motor, home and a lapsed policy; claims at many stages |
| Client | `customer.ben@demo.harborpoint.test` | Health and travel |
| Client | `customer.chen@demo.harborpoint.test` | Motor (payout account ends `0000` → simulated failure) and liability |
| Claims Operations Manager | `ops.olivia@demo.harborpoint.test` | Owns most seeded claims in intake; no monetary authority |
| Claims Operations Manager | `ops.omar@demo.harborpoint.test` | Fewest open claims, so new claims are routed to him first |
| Claims Manager | `manager.maria@demo.harborpoint.test` | Authority $50,000 |
| Claims Manager | `manager.sam@demo.harborpoint.test` | Authority $250,000 |
| Adjuster | `adjuster.adam@demo.harborpoint.test`, `adjuster.amara@demo.harborpoint.test` | Role default reserve and settlement authority: $15,000 personal, $30,000 commercial; approved the seeded settlements on their claims |
| Document Reviewer | `reviewer.raj@demo.harborpoint.test` | |
| Payment Operator | `payments.priya@demo.harborpoint.test` | Issues and reconciles payments; no settlement approval |
| Payment Operator | `payments.paul@demo.harborpoint.test` | Second operator, so payee verification can be shown (whoever changes bank details cannot verify them) |
| Data Engineer | `data.dana@demo.harborpoint.test` | Integrations, pipeline audit |
| Compliance & Security | `compliance.carlos@demo.harborpoint.test` | Compliance, users & roles, customer records, full audit |
| Compliance & Security (customer records) | `records.rosa@demo.harborpoint.test` | Same role; the login page's *Customer Records* button opens the customer records screen directly |

## 5. Move an existing Supabase project to PostgreSQL

`npm run db:import-supabase` copies a Supabase project into an **empty** PostgreSQL database. The Supabase project is only read. The script:

1. checks that `FIELD_ENCRYPTION_KEY` decrypts the source's encrypted fields (use the exact key the Supabase deployment used);
2. rebuilds the Supabase project's schema version on the target (from the Supabase CLI migration ledger, or by detecting the schema);
3. copies `auth.users` (email, password hash, metadata), every application table and the claim-number sequence with triggers suspended, so audit history and its hash chain arrive unchanged;
4. applies the migrations the Supabase project had not run (an un-upgraded project receives the PRD schema conversion here);
5. downloads every stored document from Supabase Storage into `public.document_files`;
6. verifies the audit hash chain and reports row counts, missing files and accounts without a password.

```bash
cd server
SUPABASE_DB_URL='postgresql://postgres.<ref>:<db-password>@<pooler-host>:5432/postgres' \
SUPABASE_URL='https://<ref>.supabase.co' SUPABASE_SERVICE_ROLE_KEY='<service-role key>' \
DATABASE_URL='postgresql://harborpoint:<password>@<host>:5432/harborpoint' \
FIELD_ENCRYPTION_KEY='<the key used with Supabase>' \
npm run db:import-supabase -- --yes
```

- Use the Supabase **session pooler** connection (port 5432) or the direct connection; `SUPABASE_DB_SSL` defaults to `require`.
- The target user must be allowed to `SET session_replication_role` (a superuser, or `rds_superuser` / `cloudsqlsuperuser` on managed services).
- `--skip-files` copies data only. The script exits with code 2 if any stored document could not be downloaded, and lists them.
- **Passwords:** Supabase stores bcrypt hashes. They are copied unchanged, accepted at sign-in and replaced with scrypt hashes on the user's next successful login. Accounts without a password (for example magic-link sign-ups) use *Forgot password*.
- Afterwards, start the API with the same `FIELD_ENCRYPTION_KEY`, point the web app at it, and retire the Supabase project once you have checked the data. Keep a Supabase backup until then.

## 6. Tests and checks

The server tests need a PostgreSQL server where the test user may create databases and roles (a local superuser is simplest):

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm test
npm run lint      # syntax and import-resolution checks
npm run build     # production web build
```

A global setup migrates and seeds one template database per run; each test file then gets its own clone (`create database … template …`), so files are isolated and fast, and every database is dropped at the end. Constraints, triggers and row-level-security policies run exactly as in production.

## 7. Manual UAT script

Use a database with demo data (`SEED_DEMO_DATA=true`, or `npm run db:seed-demo`; for fresh data drop and recreate the database). Each step lists the expected result.

**Client submission**
1. Sign in as `customer.alice`. The dashboard shows active claims, an "Action required" banner and open requests.
2. *New Claim* → choose `HP-PRP-200001` (lapsed): it cannot be continued. Choose `HP-MOT-100231` and continue; the draft is saved (the URL changes to `/edit`).
3. The insured name is filled from the policy and cannot be edited. Enter a loss 3 days ago (a future date or time is refused), loss type Collision, the address plus city and country, and a 20+ character description; loss ₹1,800. On *Documents*, *Continue* stays disabled until each required document is uploaded; the checklist shows Missing, Uploaded or Accepted for each. On *Contact*, the mobile number takes 10 digits after a fixed +91. Submit without the declaration → error; tick it and submit → reference `HPC-<year>-…`. The claim is assigned automatically to the Claims Operations Manager with the fewest open claims, `ops.omar`, who is notified. As `ops.omar` it appears under *Assigned to you* on the dashboard with stage *Intake*, a severity and an SLA card with the acknowledgement and intake clocks.
4. Repeat the same loss on the same policy → "Is this a separate incident?" dialog; confirm → the second claim is flagged as a possible duplicate.
5. Register a new account without ticking the privacy notice → refused; tick it → account created with the `CLIENT` role.
5a. *My claims*: filter by status, claim type and *Submitted in* (last 7 days to 12 months). On the dashboard, *Settlements paid* shows ₹ ••••• until you press the eye button.
5b. *My policies* → *Renew policy* on `HP-PRP-200001` (lapsed) → choose a term → *Request renewal*. The card shows *Renewal requested*. As `ops.olivia` open *Policy Renewals* → *Renew* → the policy becomes active until the new date and Alice is notified.

**Intake, coverage and payee (Claims Operations Manager)**
6. As `ops.omar` open the new claim. *Send to document review* is locked with an explanation. *Start coverage verification* → record *Covered* (optionally with clause references) → tick every checklist item. *Payee details* shows Alice's verified account, so *Send to document review* becomes available. Before using it, *Update bank details* with a new account: the payee becomes *Unverified*, routing is locked again, and *Verify payee* is not offered to Omar. As `ops.olivia` open the claim and *Verify payee*; as Omar, *Send to document review*.
7. Try *Place on hold* without a reason → the confirm button stays disabled. As `manager.maria` try *Start coverage verification* on another submitted claim → not offered: intake belongs to the Claims Operations Manager.

**Document review**
8. As `reviewer.raj` → *Review Queue* → preview the PDF → *Reject* with a reason. The claim returns to *Documents Required*, its SLA clock pauses, and Alice receives a request.
9. As Alice, upload a replacement from *Requests* → the claim returns to *Document Review* and the document shows version 2; *Version history* lists both versions and each can be downloaded.
10. As Raj, accept both pending documents on `HPC-2026-000104` and move the claim to *Triage & Assignment*.

**Assignment and evaluation**
11. As `manager.maria` → *Unassigned Claims* → assign `adjuster.adam` to `HPC-2026-000105` → status *Investigation*.
12. As `adjuster.adam` open `HPC-2026-000106` → *Evaluation* tab → complete the checklist, set loss value, liability and decision → *Submit evaluation* with a reserve of 3,000 → within his $15,000 authority the reserve posts immediately and the claim moves to *Compliance Review*.

**Reserve review (decision node above adjuster authority)**
13. As `manager.maria` → *Reserve Reviews*: `HPC-2026-000108` ($120,000) shows "Above limit"; *Modify amount* on `HPC-2026-000107` to 18,000 with a comment → a MANAGER_MODIFIED ledger entry appears and the claim moves to *Compliance Review*.
14. As `manager.sam` approve `HPC-2026-000108`. *Decision History* shows both decisions with each manager's limit at the time.

**Compliance**
15. As `compliance.carlos` open `HPC-2026-000109` (hold active). *Clear* is refused because of an unresolved high-severity flag; the fraud score is shown with its band. Approve an exception with a 20+ character justification → a settlement is created and the claim moves to *Settlement Approval*.
16. Open `HPC-2026-000112`, place a hold → as `payments.priya` the payment cannot be issued.

**Settlement and payment**
17. As `adjuster.adam` → *Settlement Approvals* → approve `HPC-2026-000111` ($7,800, within his $15,000 settlement authority). `adjuster.amara` does not see it: it is not her claim. Larger settlements, such as `HPC-2026-000109` ($34,900), wait for a Claims Manager.
18. As `payments.priya` issue `HPC-2026-000111` → *Paid* with a `SIM-TXN-…` reference; a PAYMENT_ISSUED reserve entry reduces the reserve.
19. As Priya open `HPC-2026-000113` (failed, account closed) → *Update payee* with a new account → the payee becomes unverified and a bank-details block opens; *Verify payee* is disabled for her. As Paul, *Verify payee*; as Priya, *Resolve & requeue* → *Issue payment* → *Paid*. Reconcile a paid payment on *Reconciliation*.

**Closure and recovery**
20. As `manager.maria` open `HPC-2026-000114` → *Closure & Recovery*: approve the adjuster's closure request → the claim closes and a CLOSURE_RELEASE ledger entry releases the remaining reserve. The subrogation recovery stays visible.

**Governance and oversight**
21. As `compliance.carlos` → *Users & roles*: grant `ADJUSTER` to a client and set an authority override; try to change your own roles → refused. Run the overdue & SLA sweep.
22. As `compliance.carlos` → *Configuration* → propose a new `sla_hours` value for PERSONAL → as `manager.maria` approve it (Carlos cannot approve his own proposal).
23. As `compliance.carlos` → *Audit log* → *Verify hash chain* → "intact". Filter by actor type *Agent* to see AI actions.
24. As `data.dana` → *Integrations*: sync runs, claim cross-references and source precedence; change a precedence rule. `/customer-records` and `/admin/users` → *Access restricted*.
25. *Reports* (Claims Manager): claims by lifecycle stage, SLA attainment and FNOL-to-payment cycle time; every chart offers a table view.
26. Check the mobile layout at ~390 px width: the sidebar becomes a menu button and the notification bell stays in the header.

**Customer records and automation**
27. Click *Customer Records* on the login page (`records.rosa`) → the customer records screen opens: search `HP-MOT-100231` (Alice), a phone fragment such as `0102` (Ben) or part of a customer ID; export CSV; open Alice to see policies, claims, documents, consents and the retention date.
28. As `ops.olivia` open `HPC-2026-000101` → *Automation*: medical report and invoice show *Not received*; *Prepare reminder draft* → review → *Approve and send*. Alice receives one notification and the document requests.
29. With `AI_PROVIDER=none` the Automation tab shows setup instructions and AI buttons are disabled. With a provider configured: *Extract fields* → review values with confidence, pages and quotes → select fields → confirm → the claim updates and the audit log records the agent run and the human confirmation.

30. **Claim agents with Ollama.** Install Ollama (ollama.com), run `ollama pull llama3.1:8b`, set `AI_PROVIDER=ollama` in `server/.env` and restart the API. Then:
    - As `ops.olivia` open `HPC-2026-000102` → *Policy & Coverage* → *Coverage check* → *Run* → review the cited clauses → *Record coverage result*.
    - As `ops.olivia` open `HPC-2026-000105` → *Overview* → *Triage, fraud and routing* → *Run* → apply severity and complexity, then *Assign adjuster* (the claim moves to Investigation). As `compliance.carlos` the same card shows the fraud score and *Record fraud flags*.
    - As `adjuster.adam` open `HPC-2026-000106` → *Reserves* → *Reserve recommendation* → *Run* → *Set reserve* (a different amount needs a reason).
    - As `payments.priya` open `HPC-2026-000111` → *Approvals* → *Payee anomaly check* → *Run* → *Mark reviewed* or *Create task for payments team*.
    - As `adjuster.amara` open `HPC-2026-000114` → *Closure & Recovery* → *Subrogation and salvage* → *Run* → *Create recovery*.
    - For a denial letter, record coverage as *Not covered* (or submit an evaluation with decision *Deny*); the adjuster runs *Denial letter* on the *Evaluation* tab and `manager.maria` edits it and selects *Approve and save letter*.

## 8. Production notes

- Run the API with `NODE_ENV=production`, `SEED_DEMO_DATA=false`, `DATABASE_SSL=verify-full` for a remote database, and secrets (`AUTH_TOKEN_SECRET`, `FIELD_ENCRYPTION_KEY`, database password) from a secrets manager. Serve `client/dist` from a static host or CDN and route `/api` to the API.
- Back up the database with your provider's point-in-time recovery or `pg_dump`; the backup contains the claim documents too (`public.document_files`). Keep the encryption key with the backup procedure, stored separately.
- Document files are limited to 10 MB each and stored out of line (TOAST). For very large volumes, plan table storage accordingly or move file contents to an object store behind the same `storage` adapter later.
- Add a real email provider by implementing the `send()` contract in `server/src/services/email.service.js` (report `SENT` only when the provider accepts the message); until then password-reset links are only logged.
- Replace the simulated payment adapter with a real provider adapter implementing `initiateTransfer()`; keep idempotency keys and the three-phase processing flow.
- Run the sweeps on one instance only (or move them to a scheduled job) when scaling horizontally.
