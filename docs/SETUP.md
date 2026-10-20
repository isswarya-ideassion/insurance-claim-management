# Setup Guide

## 1. Prerequisites

- Node.js **20.19 or newer** and npm 10
- For Supabase mode: a Supabase project (cloud or `supabase start` locally) and, optionally, the [Supabase CLI](https://supabase.com/docs/guides/cli)

Install everything from the repository root:

```bash
npm install
```

## 2. Mock mode (local demo, no credentials)

Mock mode is the default when no `.env` files exist.

```bash
npm run dev
```

- API: http://localhost:4000/api/v1 (`DATA_MODE=mock`)
- Web app: http://localhost:5173 (`VITE_APP_MODE=mock`)

What mock mode does:

| Concern | Mock mode | Supabase mode |
|---|---|---|
| Database | Embedded PGlite running the **same** migrations (`server/.data/pgdata`) | Supabase Postgres |
| Auth | Demo accounts in the embedded `auth.users` stand-in; HMAC-signed session tokens | Supabase Auth |
| Files | `server/.data/uploads` (gitignored) | Private `claim-documents` bucket |
| Email | Console adapter (`LOGGED_DEV`) | Console adapter until a provider is added |
| Payments | Simulated adapter | Simulated adapter |

Safeguards: the server refuses `DATA_MODE=mock` with `NODE_ENV=production`; the UI shows a permanent **MOCK MODE** banner; if the web app and API run in different modes, a red banner appears and sign-in is disabled; a failed Supabase login never falls back to mock authentication.

On first start the API seeds fictional demo data (14 users, 7 policies, 19 claims across every workflow stage, documents, tasks, assessments, reserves, approvals, compliance reviews, payments and notifications). Reset by deleting `server/.data/`, or run with `MOCK_DB_PERSISTENCE=memory`.

### Demo accounts (mock mode)

Password for every account: `HarborDemo!2026` (configurable with `MOCK_DEMO_PASSWORD`).

| Role | Email | Notes |
|---|---|---|
| Customer | `customer.alice@demo.harborpoint.test` | Motor, home and a lapsed policy; claims at many stages |
| Customer | `customer.ben@demo.harborpoint.test` | Health and travel |
| Customer | `customer.chen@demo.harborpoint.test` | Motor (payout account ends `0000` → simulated failure) and liability |
| Claims Operations | `ops.olivia@demo.harborpoint.test` | |
| Document Reviewer | `reviewer.raj@demo.harborpoint.test` | |
| Claims Adjuster | `adjuster.adam@demo.harborpoint.test`, `adjuster.amara@demo.harborpoint.test` | |
| Claims Manager | `manager.maria@demo.harborpoint.test` | Approval limit $50,000 |
| Claims Manager + Operations | `manager.sam@demo.harborpoint.test` | Limit $250,000; demonstrates multiple roles |
| Payment Operations | `payments.priya@demo.harborpoint.test` | |
| Compliance Officer | `compliance.carlos@demo.harborpoint.test` | |
| Data Administrator | `admin.dana@demo.harborpoint.test` | |
| Auditor | `auditor.ade@demo.harborpoint.test` | Read-only |
| Customer Records Admin | `records.rosa@demo.harborpoint.test` | All customer records, read-only + CSV export |

## 3. Supabase mode

### 3.1 Create the project and apply migrations

**With the Supabase CLI (recommended):**

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push                 # applies supabase/migrations in order
psql "$SUPABASE_DB_URL" -f supabase/seed.sql   # reference roles
```

For a local stack: `supabase start` (uses `supabase/config.toml`; migrations and `seed.sql` are applied automatically).

**Without the CLI:** open the SQL editor and run each file in `supabase/migrations/` in filename order, then `supabase/seed.sql`.

The storage migration creates the private `claim-documents` bucket (10 MB limit, PDF/JPEG/PNG/WebP). No storage policies are granted to browser roles; the API reads and writes files with the service role and streams downloads after checking access.

If you change `shared/workflow.js`, regenerate the transition migration with `npm run db:transitions-sql` and apply it as a new migration.

### 3.2 Configure Supabase Auth

In **Authentication → URL configuration** set:

- Site URL: `http://localhost:5173` (or your deployed URL)
- Redirect URLs: `http://localhost:5173/reset-password`, `http://localhost:5173/login`

Self-registered users receive only the `CUSTOMER` role (database trigger). Staff users must be created by an administrator (or the provisioning script), which sets `app_metadata.provisioned_staff = true` so no customer role is added, and then grants roles explicitly.

### 3.3 Environment variables

Copy the templates and fill in real values. **Never commit `.env` files.**

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

`server/.env`

| Variable | Description |
|---|---|
| `NODE_ENV` | `development` / `test` / `production` |
| `PORT` | API port (default 4000) |
| `CLIENT_ORIGIN` | Allowed browser origin(s), comma-separated |
| `DATA_MODE` | `supabase` or `mock` |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only.** Used to verify sessions, create staff users and access storage |
| `SUPABASE_DB_URL` | Postgres connection string — use the **session pooler** (port 5432) so transactions and row locks work |
| `SUPABASE_DB_SSL` | `true` for Supabase cloud |
| `SUPABASE_STORAGE_BUCKET` | Default `claim-documents` |
| `EMAIL_ADAPTER` | `console` (logs only) or `disabled` |
| `PAYMENT_ADAPTER` | `simulated` (only option in the MVP) |
| `OVERDUE_SWEEP_MINUTES` | Overdue-task notification interval; `0` disables |
| `AUTH_RATE_LIMIT` | Optional login/registration attempts per IP per 15 minutes |
| `MOCK_*` | Mock-mode settings (ignored in Supabase mode) |
| `DEV_SEED_PASSWORD` | Password for accounts created by `npm run provision:dev` |
| `AI_PROVIDER` | `none` (default — AI features show setup instructions) or `anthropic` |
| `ANTHROPIC_API_KEY` | **Server only.** Needed when `AI_PROVIDER=anthropic` |
| `AI_MODEL` | Default `claude-opus-5-5` |
| `AI_TIMEOUT_MS` / `AI_MAX_RETRIES` | Per-request timeout (default 90000) and retries for transient errors (default 2) |
| `REMINDER_LEAD_HOURS` | Claims due within this window get an "approaching deadline" reminder (default 24) |
| `CUSTOMER_RECORD_RETENTION_YEARS` | Retention period shown on customer records (default 7) |

`client/.env`

| Variable | Description |
|---|---|
| `VITE_APP_MODE` | `supabase` or `mock` — must match the API's `DATA_MODE` |
| `VITE_API_URL` | Default `/api/v1` (proxied by Vite to port 4000) |
| `VITE_SUPABASE_URL` | Project URL |
| `VITE_SUPABASE_ANON_KEY` | Public anon key (protected by RLS). Never put the service-role key here |

The server validates its configuration on start and refuses to run in Supabase mode with missing or placeholder values; the web app shows a configuration error instead of silently switching to mock mode.

### 3.4 Create test accounts for every role (development projects only)

```bash
DATA_MODE=supabase DEV_SEED_PASSWORD='Choose-A-Strong-Passw0rd' npm run provision:dev -- --yes
```

The script:

1. refuses to run with `NODE_ENV=production`, and requires `--yes` for non-local Supabase URLs;
2. creates the demo accounts listed in section 2 through the **Supabase Auth Admin API** (profiles come from the auth trigger — nothing is inserted into `profiles` directly);
3. grants their roles and approval limits;
4. loads the fictional policies, claims and related records, and uploads placeholder PDFs to the private bucket.

To create individual staff accounts instead, sign in as a data administrator and use **Users & roles → Create user**, or create the user in the Supabase dashboard with `app_metadata` `{"provisioned_staff": true}` and grant roles from the admin screen.

### 3.5 Run

```bash
npm run dev
```

## 4. Tests and checks

```bash
npm test          # server: unit, API integration, RLS and full lifecycle tests (PGlite); client: component/navigation tests
npm run lint      # syntax and import-resolution checks
npm run build     # production web build
```

Server tests boot the real Express app on an in-memory PGlite database with the real migrations, so constraints, triggers and RLS policies are exercised. They do not need Supabase credentials.

## 5. Manual UAT script

Use mock mode (fresh data: delete `server/.data/`). Each step lists the expected result.

**Customer submission**
1. Sign in as `customer.alice`. Dashboard shows active claims, an "Action required" banner and open requests.
2. *New Claim* → choose `HP-PRP-200001` (lapsed): it cannot be continued. Choose `HP-MOT-100231`, continue; the draft is saved (URL changes to `/edit`).
3. Enter an incident 3 days ago, category Collision, location, a 20+ character description; loss 1,800; upload a PDF as Photos; submit without the declaration → error; tick it and submit → reference `HPC-<year>-…` and the claim page.
4. Repeat the same incident on the same policy → "Is this a separate incident?" dialog; confirm → second claim flagged as possible duplicate.

**Operations intake**
5. Sign in as `ops.olivia`. Open the new claim. *Send to document review* is locked with an explanation. *Start policy verification* → *Mark verified* → tick all checklist items → *Send to document review* becomes available; use it.
6. Try *Place on hold* without a reason → the confirm button stays disabled.

**Document review**
7. Sign in as `reviewer.raj` → *Review Queue* → preview the PDF (streamed securely) → *Reject* with a reason. Claim returns to *Documents Required*; Alice receives a notification and a request; a follow-up task appears for Raj.
8. As Alice, answer the request by uploading a replacement → the claim returns to *Document Review* and the document shows version 2.
9. As Raj, accept the documents; on `HPC-2026-000104`, accept both pending documents and move the claim to *Adjuster Assignment*.

**Assignment and investigation**
10. As `manager.maria` → *Unassigned Claims* → assign `adjuster.adam` to `HPC-2026-000105` → status becomes *Investigation*.
11. As `adjuster.adam`, open `HPC-2026-000106` → *Investigation* tab → complete the checklist, set recommendation and amounts → *Submit assessment* with a reserve ≥ the recommended settlement → claim moves to *Reserve Approval*.

**Approvals**
12. As `manager.maria` → *Reserve Approvals*: `HPC-2026-000108` ($120,000) shows "Above limit" and cannot be approved; approve `HPC-2026-000107` ($18,500) → claim moves to *Compliance Review*. Return another reserve for correction → the adjuster gets a correction task and version history is kept.
13. As `manager.sam` approve `HPC-2026-000108`.

**Compliance**
14. As `compliance.carlos` open `HPC-2026-000109` (hold active). The *Clear for settlement* action is locked; *Clear* is refused because of an unresolved high-severity flag. Approve an exception with a 20+ character justification → settlement request created, claim moves to *Settlement Approval*.
15. Open `HPC-2026-000112`, place a hold → as `payments.priya` the payment cannot be processed.

**Settlement and payment**
16. As `manager.maria` approve the settlement on `HPC-2026-000111` → payment request created.
17. As `payments.priya` → *Awaiting Payment* → open `HPC-2026-000111` → *Process payment* → status *Paid* with a `SIM-TXN-…` reference; clicking again is not possible and the API rejects a second attempt.
18. Open `HPC-2026-000113` (failed, account closed) → *Update beneficiary* → *Queue retry* → *Process payment* → *Paid*. Reconcile a paid payment on *Reconciliation*.

**Closure and oversight**
19. As `ops.olivia` close `HPC-2026-000114` (paid). Add a mandatory task first to see closure blocked, complete it, then close.
20. As `auditor.ade` browse claims, decisions, payments and the audit log; no action buttons are offered and the API rejects writes.
21. As `admin.dana` grant `AUDITOR` to a customer; attempt to change your own roles → refused. Run the overdue sweep → overdue-task notifications created.
22. *Reports* (operations/manager): change the date range and grouping; every chart offers a table view.
23. Check the mobile layout at ~390 px width: the sidebar is replaced by a menu button that opens the navigation drawer; the notification bell stays in the top-right header.

**Customer records and automation**
24. As `records.rosa` → *Customer Records*: search `HP-MOT-100231` (Alice), a phone fragment such as `0102` (Ben) or part of a customer ID; filter by policy type; sort by claims; export CSV; open a customer to see policies, claim history, documents and the retention date. `/claims` is refused.
25. As `admin.dana` or `auditor.ade`, open `/customer-records` → *Access restricted*.
26. As `ops.olivia` open `HPC-2026-000101` → *Automation*: Medical report and invoice show *Not received*; *Prepare reminder draft* → review (optionally edit) → *Approve and send*. Alice receives one notification and two document requests; the history shows who approved it.
27. *Reminders* → *Check deadlines now*: owners of claims due within 24 hours (or overdue) are notified once; running it again sends nothing new.
28. With `AI_PROVIDER=none` the Automation tab shows setup instructions and AI buttons are disabled. With a real key: *Extract fields* on a document → review values, pages and quotes → select fields → confirm → the claim updates and the audit log records `CLAIM_UPDATED_FROM_EXTRACTION`. *Generate summary* shows AI suggestions separately from the recorded facts.

## 6. Production notes

- Deploy the API with `DATA_MODE=supabase` and `NODE_ENV=production`; serve `client/dist` from a static host with `VITE_APP_MODE=supabase`.
- Add a real email provider by implementing the `send()` contract in `server/src/services/email.service.js` (report `SENT` only when the provider accepts the message).
- Replace the simulated payment adapter with a real provider adapter implementing `initiateTransfer()`; keep idempotency keys and the three-phase processing flow.
- Run the overdue sweep on one instance only (or move it to a scheduled job) when scaling horizontally.
