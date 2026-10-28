# Database — PostgreSQL

> For a table-by-table reference (columns, keys, joins, which module uses each table, sample queries and the ERD), see [DATABASE-REFERENCE.md](DATABASE-REFERENCE.md).

The application uses one PostgreSQL 14+ database for everything: application data, sign-in credentials (`auth.users`) and claim document files (`document_files`). Migrations live in `database/migrations/`, run in filename order (each in its own transaction) and are recorded in `app_meta.schema_migrations`:

| File | Contents |
|---|---|
| `20261019000000_postgres_bootstrap.sql` | Platform objects the schema relies on: `pgcrypto`; the `auth` schema with `auth.users` (the API's credential store) and `auth.uid()`; the `anon` and `authenticated` roles used by the RLS policies |
| `20261019000001_core_schema.sql` … `20261020000006_customer_records_automation.sql` | The original MVP schema (ten roles, settlements, approvals, assessments). Kept unchanged so a database imported from the earlier Supabase deployment lines up migration by migration |
| `20261022000007_prd_schema.sql` | **PRD schema.** Converts the MVP schema and its data to the Enterprise Hub design (PRD §5): seven roles, authority limits, segment configuration, policy snapshots, coverage results, claim parties, document versions, artifact requirements, reviews, reserve ledger, settlement approval steps, payment blocks, payees, fraud taxonomy, SLA clocks, closure requests, recoveries, integration tables, consents, partitioned `ai_runs` and hash-chained `audit_logs`, all triggers and RLS |
| `20261022000008_workflow_transitions.sql` | **Generated** from `shared/workflow.js` (`npm run db:transitions-sql`) with the seven roles |
| `20261023000009_document_files.sql` | `document_files`: claim document contents (`bytea`, out-of-line storage), write-once with SHA-256; no access for user roles |
| `20261026000010_claims_operations_manager.sql` | Adds the `CLAIMS_OPS_MANAGER` role (Claims Operations Manager) and renames `OPS_MANAGER` to Claims Manager; adds the new role to `is_staff()`, `can_access_claim()` and the policy, payee, AI-run and reminder read policies; moves open intake and assignment tasks to the new role's queue |
| `20261026000011_workflow_transitions.sql` | **Generated** transition table with the Claims Operations Manager on intake, routing and holds |
| `20261027000012_adjuster_settlement_authority.sql` | Adjusters approve settlements on their claims within their settlement limit (15,000 personal, 30,000 commercial); Payment Operator settlement limits end; `enforce_settlement_step` updated; pending Payment Operator steps re-routed; adjusters added to the `payments` and `settlement_approval_steps` read policies |
| `20261027000013_workflow_transitions.sql` | **Generated** transition table: adjusters release approved settlements for payment |
| `20261028000015_claim_agents.sql` | Claim agents: `recoveries.ai_run_ref`; Payment Operators added to the `ai_runs` read policy; `ai_runs_protect_output` lets an accepted run gain applied parts (triage), never change its decision |
| `20261027000014_ui_enhancements.sql` | `claims.loss_city` and `loss_country`; currency defaults and existing rows changed to `INR` (codes only, amounts unchanged); past rejection notifications relabelled `CLAIM_REJECTED` / `APPROVAL_REJECTED`; new `policy_renewal_requests` table with RLS |

`database/seed.sql` inserts the eight reference roles only and is re-applied after migrations (idempotent). It never creates users.

Conventions: UUID primary keys (`gen_random_uuid()`), `timestamptz` everywhere (UTC), money as `numeric(14,2)` with a currency, JSON structures as `jsonb`, enumerations as `text` with CHECK constraints, `version` columns for optimistic locking (bumped by trigger), `audit_logs` and `ai_runs` partitioned by month (`create_monthly_partitions`; the API creates upcoming partitions at start and in the sweep).

## Upgrading an existing database

`007` runs as one migration and converts data rather than recreating tables:

- **Roles:** `CUSTOMER` → `CLIENT`; `CLAIMS_OPERATIONS`, `CLAIMS_MANAGER` → `OPS_MANAGER`; `CLAIMS_ADJUSTER` → `ADJUSTER`; `PAYMENT_OPERATIONS` → `PAYMENT_OPERATOR`; `COMPLIANCE_OFFICER`, `DATA_ADMIN`, `AUDITOR`, `CUSTOMER_RECORDS_ADMIN` → `COMPLIANCE_SECURITY`. Manager approval limits become `user_attributes` overrides.
- **Renames:** `profiles` → `users`, `assessments` → `evaluations`, `information_requests` → `artifact_requirements`; claim `incident_*` → `loss_*`, `submitted_at` → `opened_at`; policy `policy_number` → `external_policy_no`, `holder_id` → `insured_id`, `effective_from/to` → `effective_date`/`expiry_date`; task `assignee_id` → `owner_user_id`, `is_mandatory` → `blocking`.
- **Merges:** settlements become `payments` rows in `PENDING_APPROVAL` (or later); approval rows become `settlement_approval_steps` and `reviews`; compliance reviews become `reviews` of type `COMPLIANCE` with their risk flags in `claim_fraud_flags`.
- **Sensitive data:** policy payout accounts become `payees`; claim contacts move to `claim_parties`. Both are stored as `plain:` and encrypted by the API on its next start (`encryptLegacyFields`, needs `FIELD_ENCRYPTION_KEY`).
- **Audit:** existing audit rows are copied into the partitioned, hash-chained table in their original order.

## Entity overview

```
auth.users 1─1 users 1─* user_roles *─1 roles          users 1─1 user_attributes
roles 1─* authority_limits          segment_config (per segment, versioned)
users 1─* policies 1─* claims        payees 1─* policies, payments
claims 1─1 policy_snapshots 1─* coverage_results
claims 1─* claim_parties, claim_assignments, claim_notes, claim_status_history, sla_clocks,
          artifact_requirements, documents 1─* document_versions, tasks 1─* task_sources,
          evaluations, reserves (ledger), reviews, claim_fraud_flags *─1 fraud_reason_codes,
          payments 1─* settlement_approval_steps, payment_blocks, payment_attempts,
          closure_requests, recoveries, claim_xref, claim_reminders, ai_runs, notifications
users 1─* consents                   integration_sync_runs, source_precedence
audit_logs (polymorphic, partitioned, hash-chained)
```

## Tables

| Table | Purpose | Notable constraints |
|---|---|---|
| `roles` | The eight role codes | `code` unique |
| `users` | One row per auth user (created by trigger on `auth.users`; self-registration gets `CLIENT`) | PK references `auth.users`; unique lower(email) |
| `user_roles` | Role grants | unique (user, role) |
| `user_attributes` | Per-user `reserve_limit`, `settlement_limit` overrides, region, team | limits ≥ 0 |
| `authority_limits` | Role defaults by segment, coverage line and limit type (`RESERVE`, `SETTLEMENT`) | `max_amount > 0`; creator ≠ approver; `effective_limit()` resolves override then default |
| `segment_config` | Versioned settings per segment: `required_artifacts`, `sla_hours`, `severity_thresholds`, `fraud_review_threshold`, `unclaimed_task_escalation_hours` | one ACTIVE version per (segment, key); proposer ≠ approver (API) |
| `policies` | Insurance contracts | unique `external_policy_no`; `expiry_date > effective_date`; `segment`, `coverages`, `limits`, `payee_id` |
| `policy_renewal_requests` | Customer renewal requests and the staff decision (`REQUESTED` → `COMPLETED` / `DECLINED`), previous and new expiry, linked task | one open request per policy; decider ≠ requester; a completed request records `new_expiry > previous_expiry`; a declined one needs a reason |
| `policy_snapshots` | Policy frozen at submission, with SHA-256 | one per claim |
| `claims` | The claim, status, derived `stage`, segment, severity, `fraud_score`, `reopen_count`, `version`; loss location as `loss_location` + `loss_city` + `loss_country` | status CHECK; `stage` set by trigger from `claim_stage()`; submitted claims need policy, loss date, loss amount, declaration and `opened_at` |
| `claim_parties` | Claimant, insured, witnesses, third parties | `contact_encrypted` (AES-256-GCM) |
| `coverage_results` | Each coverage check: result, clause references, deductible | result CHECK |
| `claim_assignments`, `claim_notes`, `claim_status_history` | Assignment history, notes, transitions | one active assignment per (claim, role); history **immutable** |
| `documents` / `document_versions` | Latest metadata and every stored version | allowed MIME types, ≤ 10 MB; `extracted_fields` from AI extraction; previous versions marked `SUPERSEDED` |
| `artifact_requirements` | Required documents per claim plus ad-hoc document/information requests | status CHECK (`MISSING`, `REQUESTED`, `RECEIVED`, `ACCEPTED`, `REJECTED`, `WAIVED`, `CLOSED`, `CANCELLED`) |
| `tasks` / `task_sources` | Work items with owner user or role queue, `blocking`, due dates; links to legacy to-dos | status/priority CHECK |
| `evaluations` | Versioned adjuster evaluations: `loss_value`, `liability_pct`, `decision` | unique (claim, version) |
| `reserves` | **Ledger** by coverage line: `amount`, `prev_amount`, `reason_code`, `authority_ok`, `approval_status` (`POSTED`, `PENDING_REVIEW`, `APPROVED`, `MODIFIED`, `REJECTED`, `RETURNED`, `SUPERSEDED`) | posted amounts cannot change (trigger); outside authority needs an approver; approver ≠ setter |
| `reviews` | Reverse-review checkpoints: `COMPLIANCE`, `RESERVE`, `EVALUATION`, `CLOSURE` | decided rows **immutable**; reviewer ≠ requester |
| `fraud_reason_codes` / `claim_fraud_flags` | Weighted taxonomy and per-claim flags | trigger recomputes `claims.fraud_score` (sum of open contributions, max 100) |
| `payees` | Payee master: encrypted bank details, HMAC hash, verification | verifier ≠ person who changed the bank details |
| `payments` | Settlement and payment: `PENDING_APPROVAL → PENDING → PROCESSING → PAID | FAILED`, `PAID → RECONCILED`, plus `REJECTED`, `RETURNED`, `CANCELLED` | state machine trigger; `portal_reference` unique; `is_simulated` |
| `settlement_approval_steps` | Ordered steps with required role (`ADJUSTER` or `OPS_MANAGER`) and the approver's limit at decision | trigger checks role and authority; adjuster steps only by the assigned adjuster; Claims Manager steps preparer ≠ approver |
| `payment_blocks` | `PAYMENT_FAILED`, `COMPLIANCE_HOLD`, `PAYEE_UNVERIFIED`, `BANK_DETAILS_CHANGED` | resolution requires resolver and text |
| `payment_attempts` | Each issue attempt | unique `idempotency_key`; completed attempts immutable; issuer ≠ settlement approver (trigger) |
| `sla_clocks` | `ACKNOWLEDGE` and `STAGE` clocks with pause, breach and escalation level | escalation level 0–3 |
| `closure_requests` | Adjuster requests, Claims Manager decisions | one pending per claim; requester ≠ decider |
| `recoveries` | Subrogation and salvage | amounts ≥ 0 |
| `integration_sync_runs`, `claim_xref`, `source_precedence` | Pipeline health, cross-system claim matching, conflict rules | unique (source, external id) |
| `consents` | Privacy notice, claim declaration and channel consents with notice version | |
| `notifications` | One row per channel (`IN_APP` with `read_at`; `EMAIL` with delivery status) | email `SENT` only from a real provider |
| `claim_reminders` | Deadline reminders and client reminder drafts | client reminders cannot be sent without a recorded approver |
| `ai_runs` | Every Claude call (partitioned by month): agent, `prompt_version`, model, `input_hash`, output, numeric `confidence`, `needs_human`, `human_decision` | output **immutable** (trigger) |
| `document_files` | Stored document contents, keyed by `storage_key` | write-once (trigger); mime type and 10 MB limit; RLS with no policies |
| `audit_logs` | Append-only trail (partitioned by month): `seq`, `occurred_at`, `actor_type` (`USER`, `AGENT`, `SYSTEM`), `before`, `after`, `ip`, `request_id`, `hash_prev`, `hash` | **immutable**; hash chain assigned by `audit_logs_chain` under an advisory lock |
| `claim_status_transitions` | Permitted transitions and roles (generated) | PK (from, to) |

## Database-enforced business rules

These hold even if the API were bypassed:

- **Status transitions** — `enforce_claim_status_rules` rejects transitions not in `claim_status_transitions`, held claims resuming to a different status, settlement or payment while a compliance hold is active, and closing with open blocking tasks. It derives `stage` and increments `reopen_count`.
- **Monetary authority** — `enforce_settlement_step` checks the approver holds the required role and that the amount is within `effective_limit()`; reserve rows outside authority cannot be posted without an approver.
- **Separation of duties** — preparer ≠ approver (settlement steps, reserves, reviews, closure requests); approver ≠ issuer (`enforce_issuer_not_approver`); bank-detail changer ≠ payee verifier.
- **Payments** — `enforce_payment_rules` allows only the documented state changes and blocks issue while a block or compliance hold is open.
- **Ledger and immutability** — reserves, decided reviews, status history, audit logs, completed payment attempts and AI outputs cannot be updated or deleted.
- **Fraud score** — `recompute_fraud_score` keeps `claims.fraud_score` equal to the weighted sum of open flags.
- **Audit chain** — `hash = sha256(hash_prev || audit_payload(row))`; `verify_audit_chain()` returns every row whose stored hash or link does not match.
- **Claim numbers** — `next_claim_number()` returns `HPC-<year>-<sequence>`.

Trigger errors use a `CODE: message` format that the API maps to `409` responses with the same code.

The demo seed sets `app.seed_mode = 'on'` for its own transaction so historical demo records can be inserted at later stages; the setting is transaction-local.

## Row-level security

RLS is enabled on every table, and partitions cannot be queried directly. The Express API connects with a privileged database role and enforces authorization in its service layer; RLS is defense in depth: any connection that runs as the `authenticated` role with `request.jwt.claims` set (for example a reporting tool or a future PostgREST layer) only sees what the policies allow.

Helper functions (`security definer`, fixed `search_path`): `has_role`, `has_any_role`, `is_staff`, `can_access_claim(claim_id)` (mirrors the API claim scope), `can_staff_access_claim`.

Claim scope (`can_access_claim`): the client who owns the claim; `CLAIMS_OPS_MANAGER`, `OPS_MANAGER` and `COMPLIANCE_SECURITY` for every submitted claim; `DOCUMENT_REVIEWER` during intake and review stages or when assigned; `ADJUSTER` when assigned; `PAYMENT_OPERATOR` from settlement approval onward. `DATA_ENGINEER` reads submitted claims through a separate policy but no claim children.

| Table(s) | Who can read | Who can write directly |
|---|---|---|
| `roles`, `claim_status_transitions` | any signed-in user | nobody |
| `users` | self, staff | self (`full_name`, `phone` only) |
| `user_roles` | self, Compliance & Security | Compliance & Security, **never for themselves** |
| `user_attributes`, `authority_limits`, `segment_config` | staff | nobody (API, four-eyes) |
| `policies` | insured client, staff | nobody |
| `policy_renewal_requests` | requester, the policy's insured client, Claims Operations Manager, Claims Manager, Compliance & Security | nobody (API only) |
| `payees` | the client, Claims Operations Managers, Payment Operators, Claims Managers, Compliance & Security | nobody |
| `claims` | owner, creator of a draft, staff within scope, Data Engineers (submitted) | clients: insert/update **own drafts only** |
| notes, status history, parties, snapshots, coverage, documents, artifacts, SLA clocks | users with claim scope (clients see customer-safe rows only) | nobody |
| `evaluations`, `reserves`, `reviews` | Claims Managers, Adjusters, Compliance & Security within scope (reserves also Payment Operators; compliance reviews not Adjusters) | nobody |
| payments, steps, blocks, attempts | Payment Operators, Claims Managers, Compliance & Security within scope | nobody |
| `consents` | the subject, Compliance & Security | nobody |
| `notifications` | recipient | recipient (`read_at`, `status`) |
| `audit_logs` | Compliance & Security (all); Claims Managers (claims in scope); Data Engineers (integration, system and job entries) | nobody |
| integration tables | Data Engineers, Compliance & Security | nobody |
| `ai_runs`, `claim_reminders` | Claims Operations Managers, Claims Managers, Document Reviewers, Compliance & Security within scope | nobody |

`anon` has no table privileges, and `document_files` grants nothing to `anon` or `authenticated`, so only the API can read or write document contents.

These policies are exercised by `server/tests/integration/rls.test.js`, which switches to the `authenticated` role with JWT claims on a real PostgreSQL test database.

## Credentials and imported Supabase accounts

`auth.users` holds `email`, `encrypted_password`, `raw_user_meta_data` (name, phone) and `raw_app_meta_data` (`provisioned_staff` for staff created by Compliance & Security). The `handle_new_auth_user` trigger creates the matching `public.users` row and, for self-registration, the `CLIENT` role. Passwords set by the API are scrypt hashes (`scrypt$salt$hash`); bcrypt hashes copied from Supabase Auth by `npm run db:import-supabase` are accepted at sign-in and replaced with scrypt on the next successful login.
