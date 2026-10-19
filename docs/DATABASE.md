# Database — Supabase PostgreSQL

Migrations live in `supabase/migrations/` and run in order:

| File | Contents |
|---|---|
| `20261019000001_core_schema.sql` | Tables, foreign keys, CHECK constraints, indexes |
| `20261019000002_functions_triggers.sql` | `updated_at` maintenance, auth-user → profile provisioning, claim-number generator, status-transition trigger, approval-authority trigger, payment state machine, immutable records |
| `20261019000003_workflow_transitions.sql` | **Generated** from `shared/workflow.js` (`npm run db:transitions-sql`) |
| `20261019000004_row_level_security.sql` | Helper functions, privileges, RLS policies |
| `20261019000005_storage.sql` | Private `claim-documents` bucket |

`supabase/seed.sql` inserts reference roles only. It never creates authentication identities or profiles.

Conventions: UUID primary keys (`gen_random_uuid()`), `timestamptz` everywhere (UTC), money as `numeric(14,2)`, JSON structures as `jsonb`, enumerations as `text` with CHECK constraints.

## Entity overview

```
auth.users 1─1 profiles 1─* user_roles *─1 roles
profiles 1─* policies 1─* claims
claims 1─* claim_assignments, claim_notes, claim_status_history, information_requests,
          documents, tasks, assessments, reserves, settlements, approvals,
          compliance_reviews, payments, notifications, audit_logs
assessments 1─* reserves, settlements
reserves 1─* approvals (RESERVE)        settlements 1─* approvals (SETTLEMENT)
settlements 1─1 payments 1─* payment_attempts
information_requests 1─* documents
```

## Tables

| Table | Purpose | Notable constraints |
|---|---|---|
| `roles` | The nine role codes | `code` unique |
| `profiles` | One row per auth user (created by trigger on `auth.users`) | PK references `auth.users`; unique lower(email) |
| `user_roles` | Role grants; `approval_limit` for `CLAIMS_MANAGER` | unique (user, role) |
| `policies` | Insurance contracts (reference data) | unique policy number; `effective_to > effective_from`; positive sum insured |
| `claims` | The claim, its current status and denormalised assignees | status CHECK; `claim_number` required unless draft/withdrawn; submitted claims must have policy, incident date, loss, declaration and `submitted_at`; `ON_HOLD` requires `hold_from_status`; unique `submission_key` (idempotency) |
| `claim_assignments` | Assignment history per role | one active assignment per (claim, role) — partial unique index |
| `claim_notes` | Internal or customer-visible notes | visibility CHECK |
| `claim_status_history` | Every transition with reason and customer message | **immutable** |
| `information_requests` | Missing-document / information requests | status CHECK |
| `documents` | File metadata; files in private storage | allowed MIME types; ≤ 10 MB; unique (group, version); rejection requires a reason |
| `tasks` | Work items, mandatory flag, due dates, overdue notification marker | status/priority CHECK |
| `assessments` | Versioned adjuster assessments | unique (claim, version) |
| `reserves` | Reserve requests | amount > 0; one pending per claim |
| `settlements` | Settlement requests with beneficiary snapshot | amount > 0; one open per claim |
| `approvals` | One immutable row per reserve/settlement decision | `requested_by <> decided_by`; target matches type; approved amount ≤ approver limit; **immutable** |
| `compliance_reviews` | Reviews, checklist, risk flags, evidence, holds | exception requires reason; `hold_active` only in HOLD/ESCALATED |
| `payments` | One payment per settlement (`settlement_id` unique) | amount > 0; status CHECK; unique transaction reference; `is_simulated` |
| `payment_attempts` | Each processing attempt | unique `idempotency_key`; unique (payment, attempt_no); completed attempts immutable |
| `notifications` | In-app notifications and email delivery status | email status CHECK (`SENT` only from a real provider) |
| `audit_logs` | Append-only change log with actor, roles, request id, before/after diff | **immutable** |
| `claim_status_transitions` | Permitted transitions (generated) used by the trigger | PK (from, to) |

## Database-enforced business rules

These hold even if the API were bypassed:

- **Status transitions** — `claims_enforce_status_rules` rejects any status change not in `claim_status_transitions`, held claims resuming to a different status, moving to settlement/payment/paid while a compliance hold is active, releasing payment without an approved settlement, and closing a paid claim with open mandatory tasks. New claims must start as `DRAFT`.
- **Approval authority** — `approvals_enforce_authority` requires the decider to hold `CLAIMS_MANAGER` and stamps their current limit; CHECK constraints block self-approval and over-limit approvals.
- **Payments** — `payments_enforce_rules` requires an approved settlement with a matching amount, allows only `PENDING→PROCESSING|CANCELLED`, `PROCESSING→PAID|FAILED`, `FAILED→PENDING|CANCELLED`, `PAID→RECONCILED`, and blocks `PROCESSING` under a compliance hold.
- **Immutability** — audit logs, approvals and status history cannot be updated or deleted; completed payment attempts cannot be modified.
- **Claim numbers** — `next_claim_number()` returns `HPC-<year>-<sequence>` from `claim_number_seq`.

Trigger errors use a `CODE: message` format that the API maps to `409` responses with the same code.

Development provisioning sets `app.seed_mode = 'on'` for its own transaction so historical demo records can be inserted at later stages; the setting is transaction-local.

## Row-level security

RLS is enabled on every table. The Express API connects with a privileged database role and enforces authorization in its service layer; RLS is the boundary for any access using a user JWT (supabase-js / PostgREST with the anon key).

Helper functions (`security definer`, fixed `search_path`): `has_role`, `has_any_role`, `is_staff`, `can_access_claim(claim_id)` (mirrors the API's claim scope), `can_staff_access_claim`.

| Table(s) | Who can read | Who can write directly |
|---|---|---|
| `roles`, `claim_status_transitions` | any signed-in user | nobody |
| `profiles` | self, staff | self (`full_name`, `phone` only) |
| `user_roles` | self, data admins, auditors | data admins, **never for themselves** |
| `policies` | holder, claim-handling staff | nobody |
| `claims` | owner, creator of a draft, staff within scope | customers: insert/update **own drafts only** |
| notes / status history | in-scope users; customers only customer-visible rows | nobody |
| documents, information requests | in-scope users | nobody (uploads go through the API) |
| tasks | staff (assignee, creator or in-scope claim) | nobody |
| assessments, reserves, settlements, approvals | specific staff roles within scope | nobody |
| compliance reviews | compliance, managers, auditors | nobody |
| payments / attempts | payment ops, managers, compliance (payments), auditors | nobody |
| notifications | recipient | recipient (`is_read`, `read_at` only) |
| audit logs | auditors, compliance, managers, data admins | nobody |

`anon` has no table privileges. Storage has no client policies on `claim-documents`, so only the service role (the API) can read or write objects.

These policies are exercised by `server/tests/integration/rls.test.js`, which switches to the `authenticated` role with JWT claims inside PGlite.

## Mock mode

Mock mode runs the same migrations on embedded PGlite after `server/src/db/supabase-stubs.sql`, which creates minimal stand-ins for Supabase's `auth.users`, `auth.uid()`, `storage.buckets` and the `anon` / `authenticated` / `service_role` roles. The stubs are never applied to Supabase.
