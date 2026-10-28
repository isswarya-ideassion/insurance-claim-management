# API Reference — `/api/v1`

Base URL in development: `http://localhost:4000/api/v1` (the web app proxies `/api` to it).

## Conventions

**Authentication.** Every endpoint except `/health`, `/auth/login`, `/auth/register`, `/auth/forgot-password` and `/auth/reset-password` requires `Authorization: Bearer <access token>`. The token comes from `POST /auth/login` (HS256, signed with `AUTH_TOKEN_SECRET`, valid `AUTH_TOKEN_TTL_HOURS`, default 8).

**Responses.**

```json
{ "data": { ... }, "meta": { "page": 1, "pageSize": 20, "total": 42, "totalPages": 3 } }
```

```json
{ "error": { "code": "WORKFLOW_GUARD_FAILED", "message": "Cannot move claim HPC-2026-000102 to Document Review: Coverage must be recorded as covered.", "details": { "failures": [ ... ] }, "requestId": "6f0c…" } }
```

Every response carries an `x-request-id` header, also stored on audit records.

**Status codes.** `400` malformed request · `401` not authenticated · `403` authenticated but not permitted (codes such as `TRANSITION_NOT_PERMITTED`, `APPROVAL_LIMIT_EXCEEDED`, `APPROVAL_NOT_AUTHORISED`, `SELF_APPROVAL_FORBIDDEN`, `SEPARATION_OF_DUTIES`, `CONFLICT_OF_INTEREST`) · `404` not found **or outside your scope** (claim existence is never disclosed) · `409` business-rule conflict (`WORKFLOW_GUARD_FAILED`, `POSSIBLE_DUPLICATE`, `VERSION_CONFLICT`, `COMPLIANCE_HOLD_ACTIVE`, `PAYMENT_BLOCKED`, `PAYMENT_NOT_PENDING`, …) · `413` upload too large · `415` unsupported file type · `422` validation error or invalid transition · `429` rate limited.

**Pagination.** `page` (default 1) and `pageSize` (default 20, max 100).

**Optimistic locking.** Claim updates accept the `version` you loaded; a stale version returns `409 VERSION_CONFLICT`.

**Roles.** `CLIENT`, `CLAIMS_OPS_MANAGER` (Claims Operations Manager), `OPS_MANAGER` (Claims Manager), `ADJUSTER`, `DOCUMENT_REVIEWER`, `PAYMENT_OPERATOR`, `DATA_ENGINEER`, `COMPLIANCE_SECURITY`. The permission behind each endpoint is in `shared/permissions.js`.

---

## Health & authentication

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ status, database: "postgres", demoData, simulatedPayments, aiConfigured, time }` |
| GET | `/auth/me` | Profile, roles, `limits` (`{ reserve: { PERSONAL, COMMERCIAL }, settlement: { … } }` for staff), permissions, visible claim tabs |
| PATCH | `/auth/me` | `{ fullName?, phone? }` — roles cannot be changed here |
| POST | `/auth/login` | `{ email, password }` → `{ accessToken, expiresIn, tokenType }`. Rate-limited; the same error for unknown emails and wrong passwords |
| GET | `/auth/me/consents` | Own consent history (notice version, granted, withdrawn) |
| POST | `/auth/me/consents` | `{ consentType, granted }` — record or withdraw a consent (`CLAIM_DECLARATION` is recorded at submission only) |
| POST | `/auth/register` | `{ email, password, fullName, phone?, acceptPrivacyNotice: true }`. Grants `CLIENT` only and records the privacy-notice consent |
| POST | `/auth/forgot-password` | `{ email }`. Same answer whether or not the account exists. With the console email adapter the reset link is written to the server log (`delivery: "LOGGED_DEV"`) |
| POST | `/auth/reset-password` | `{ token, password }`; tokens expire after 30 minutes and are single-use |


```http
POST /api/v1/auth/login
{ "email": "ops.olivia@demo.harborpoint.test", "password": "HarborDemo!2026" }

200 { "data": { "accessToken": "eyJ…", "expiresIn": 28800, "tokenType": "bearer" } }
```

## Policies

| Method | Path | Notes |
|---|---|---|
| GET | `/policies?search&status&type&segment` | Clients: own policies. Staff: all. Payout account is masked (`payout_account_masked`). Each policy carries its latest `renewal` request (or `null`) |
| GET | `/policies/:id` | |
| POST | `/policies/eligibility` | `{ policyNumber, lossDate?, claimType?, lossType?, estimatedLoss? }` → `{ eligible, reasons[], checks{}, policy }` |
| POST | `/policies/:id/renewal-requests` | Client, own policy. `{ termMonths?: 6\|12\|24 (default 12), notes? }`. One open request per policy (`RENEWAL_ALREADY_REQUESTED`); cancelled policies cannot be renewed (`POLICY_NOT_RENEWABLE`). Creates a `POLICY_RENEWAL` task for the Claims Operations Manager queue |
| GET | `/policy-renewals?status` | Claims Operations Manager, Claims Manager, Compliance & Security. Rows carry `policy_number`, `expiry_date`, `proposed_expiry` and `canDecide` |
| POST | `/policy-renewals/:id/decision` | Claims Operations Manager or Claims Manager. `{ decision: "COMPLETED"\|"DECLINED", reason? }` (reason required to decline). Completing sets `expiry_date` to the current expiry (or today, if expired) plus the term and makes the policy `ACTIVE`; the customer is notified |

## Claims

| Method | Path | Notes |
|---|---|---|
| GET | `/claims` | Filters: `search`, `status` (CSV), `stage` (CSV), `segment`, `claimType`, `priority`, `assigneeId` (`uuid`/`me`/`unassigned`), `needsAdjuster`, `overdue`, `escalated`, `from`, `to`, `sort` (default `opened_at`), `order`. Rows include `stage_label`, `severity` and the fraud score or band the caller may see |
| GET | `/claims/stats` | Dashboard counts within your scope |
| POST | `/claims` | Create draft (client, or Claims Operations Manager on behalf with `policyNumber`). Claimant contact is stored encrypted in `claim_parties` |
| GET | `/claims/:id` | Client projection or staff detail: policy (from the snapshot), eligibility, `coverage`, `slaClocks`, `closureRequest`, required and missing documents, current task, checklist, counts, permissions |
| PATCH | `/claims/:id` | Draft fields (claimant) or `{ priority, dueDate, complexity }` (Claims Operations Manager or Claims Manager); both accept `version` |
| DELETE | `/claims/:id` | Discard draft (recorded as withdrawn) |
| POST | `/claims/:id/submit` | `{ submissionKey?, confirmSeparateClaim? }` or `Idempotency-Key` header. Freezes the policy snapshot, creates the required artifacts, records the declaration consent, sets severity, starts the acknowledgement and stage clocks, and assigns the claim to the Claims Operations Manager with the lightest workload (or keeps it with the one who raised it) |
| GET | `/claims/:id/transitions` | Transitions you may attempt now, with blocking guards |
| POST | `/claims/:id/transitions` | `{ toStatus, reason?, customerMessage? }` |
| POST | `/claims/:id/coverage-check` | Claims Operations Manager. `{ result: "COVERED"|"NOT_COVERED"|"NEEDS_REVIEW", notes?, clauseRefs?[] }` |
| GET | `/claims/:id/coverage-results` | Coverage check history |
| GET | `/claims/:id/sla-clocks` | Clocks with `running`, `paused_at`, `breached_at`, `escalation_level`, `remaining_hours` |
| PATCH | `/claims/:id/intake-checklist` | `{ items: { POLICY_ACTIVE: true, … } }` |
| POST | `/claims/:id/escalate` | `{ reason }` |
| POST | `/claims/:id/document-exception` | Manager. `{ reason }` |
| GET/POST | `/claims/:id/notes` | `{ body, visibility: "INTERNAL"|"CUSTOMER" }` |
| GET | `/claims/:id/timeline` | Merged activity (customer-safe for claimants) |

```http
POST /api/v1/claims
{ "policyNumber": "HP-MOT-100231", "lossDate": "2026-10-15T10:30:00Z", "lossLocation": "14 MG Road, opposite City Mall",
  "lossCity": "Kochi", "lossCountry": "India",
  "lossType": "COLLISION", "lossDescription": "Another car merged into my lane…",
  "estimatedLoss": 1850, "affectedAsset": "2023 Volvo XC40", "contactName": "Alice Thornton",
  "contactPhone": "98450 10101", "contactEmail": "alice@example.test", "declarationAccepted": true, "draftStep": 6 }

201 { "data": { "id": "…", "status": "DRAFT", "claim_number": null, … } }
```

Field rules for drafts and submission:

- `lossDate` cannot be more than five minutes in the future (checked on every draft save and at submission).
- `lossLocation` (address or place, up to 500 characters), `lossCity` and `lossCountry` are separate; all three are required to submit.
- `contactPhone` (and `phone` on registration, profile and staff accounts) must be an Indian mobile number: 10 digits starting 6–9, with or without `+91`, `91` or a leading `0`. It is stored as `+91 98450 10101`.
- `insuredName` is ignored for customers; the claim always takes the insured name from the policy. Staff filing on a customer's behalf may correct it.
- Amounts are Indian rupees (`INR`); messages and notes format them as `₹7,800.00`.

```http
POST /api/v1/claims/{id}/submit
Idempotency-Key: 9b2f3c4e-…

201 { "data": { "claim_number": "HPC-2026-001003", "status": "SUBMITTED", … }, "meta": { "replayed": false } }
409 { "error": { "code": "POSSIBLE_DUPLICATE", "details": { "existing": [ { "claim_number": "HPC-2026-001002", … } ] } } }
```

```http
POST /api/v1/claims/{id}/transitions
{ "toStatus": "PAID" }

422 { "error": { "code": "INVALID_TRANSITION",
      "message": "Claim HPC-2026-000101 cannot move from Submitted to Paid. Permitted next statuses: Coverage Verification, On Hold, Withdrawn.",
      "details": { "from": "SUBMITTED", "to": "PAID", "allowed": ["POLICY_VERIFICATION", "ON_HOLD", "WITHDRAWN"] } } }
```

## Assignments

| Method | Path | Notes |
|---|---|---|
| GET | `/claims/:id/assignments` | Full history |
| POST | `/claims/:id/assignments` | `{ assigneeId, assignmentRole: "OPERATIONS_OWNER"|"DOCUMENT_REVIEWER"|"ADJUSTER", reason? }` — reason required when reassigning. Assigning an adjuster in *Triage & Assignment* starts the investigation |
| GET | `/assignments/assignees?role=ADJUSTER` | Eligible staff with active-claim counts |
| GET | `/assignments/workload` | Team workload (Claims Managers, Compliance & Security) |

## Documents & artifact requirements

| Method | Path | Notes |
|---|---|---|
| GET | `/claims/:id/documents` | Latest version of each document (`doc_type`, `version`, `received_at`, `status`). Clients do not see internal evidence types |
| POST | `/claims/:id/documents` | `multipart/form-data`: `file`, `docType`, `artifactRequirementId?`, `replacesDocumentId?`, `changeReason?` — PDF/JPEG/PNG/WebP, ≤ 10 MB, content-sniffed. A replacement increments `version` on the same document |
| GET | `/documents/:id/download?disposition=inline|attachment&version=` | Streams the file (or an earlier version) after an access check; `Cache-Control: private, no-store`; audited |
| GET | `/documents/:id/versions` | `document_versions` rows, newest first |
| GET | `/documents/review-queue?status&mine&docType` | Document Reviewers |
| POST | `/documents/:id/review` | `{ decision: "ACCEPT"|"REJECT", comment?, rejectionReason? }` |
| POST | `/documents/:id/assign-reviewer` | `{ reviewerId }` |
| GET | `/claims/:id/artifact-requirements` | Required documents (`is_required`) and ad-hoc requests with status `MISSING`, `REQUESTED`, `RECEIVED`, `ACCEPTED`, `REJECTED`, `WAIVED`, `CLOSED`, `CANCELLED` |
| POST | `/claims/:id/artifact-requests` | `{ requirementType: "DOCUMENT"|"INFORMATION", docType?, message, dueAt? }` — the client is notified and the stage clock pauses while they owe documents |
| GET | `/artifact-requests?status` | Requests across claims in your scope (clients: what they still owe) |
| POST | `/artifact-requests/:id/respond` | Client. `{ responseText }` (document requests are answered by uploading) |
| POST | `/artifact-requests/:id/close` | Staff. Cancels an open ad-hoc request or closes a received one; required artifacts close through review or a document exception |

```http
POST /api/v1/documents/{id}/review
{ "decision": "REJECT", "rejectionReason": "Invoice is not itemised" }

200 { "data": { "document": { "status": "REJECTED", … }, "claimStatus": "DOCUMENTS_REQUIRED" } }
```

## Tasks

| Method | Path | Notes |
|---|---|---|
| GET | `/tasks?view=mine|team&status&overdue&unclaimed&claimId` | `mine` includes unclaimed tasks queued for your roles |
| POST | `/tasks` | `{ claimId?, title, description?, type, priority, blocking, ownerUserId?, ownerRole?, dueAt? }` |
| PATCH | `/tasks/:id` | `{ status?, ownerUserId?, dueAt?, priority? }` — starting an unclaimed task claims it; only Claims Managers and Claims Operations Managers cancel blocking tasks |
| GET | `/claims/:id/tasks` | |

Unclaimed queue tasks escalate to Claims Managers after `unclaimed_task_escalation_hours` (segment configuration).

## Evaluations, reserves and settlements

| Method | Path | Notes |
|---|---|---|
| GET | `/claims/:id/evaluations` | All versions |
| POST | `/claims/:id/evaluations` | Assigned adjuster; a new version carries the previous content |
| PATCH | `/evaluations/:id` | Draft only: `{ checklist, findings, evidence[], lossValue, liabilityPct, recommendedSettlement, decision: "PAY_FULL"|"PAY_PARTIAL"|"DENY", internalNotes }` |
| POST | `/evaluations/:id/submit` | `{ reserveAmount, reserveReason?, coverageLine? }` (omit for `DENY`). Within the adjuster's reserve authority the reserve is `POSTED` and the claim moves to compliance review; above it the reserve is `PENDING_REVIEW` and the claim moves to reserve review |
| POST | `/evaluations/:id/return` | Claims Manager. `{ comment }` |
| GET | `/claims/:id/reserves` | Reserve ledger. Entries awaiting review include `canDecide`, `canApprove`, `reason`, `limit` for the caller |
| POST | `/claims/:id/reserves` | Assigned adjuster revises the reserve: `{ amount, reasonCode, coverageLine?, notes? }` — a new ledger entry, posted or sent for review by authority |
| GET | `/reserves/queue` | Claims Managers: entries awaiting review with the evaluation summary |
| POST | `/reserves/:id/review` | `{ decision: "APPROVED"|"MODIFIED"|"REJECTED"|"RETURNED", comments?, modifiedAmount? }` — comments required unless approved; `MODIFIED` writes a `MANAGER_MODIFIED` entry |
| GET | `/claims/:id/settlements` | Payments with their `steps` (settlement approval steps) and the caller's capability |
| GET | `/settlements/queue?awaitingMe` | Pending steps with `required_role`, approved reserve and compliance-hold flag. `awaitingMe=true` keeps only steps that need one of the caller's roles |
| POST | `/settlements/:id/approvals` | `{ decision: "APPROVED"|"REJECTED"|"RETURNED", comments? }` on the pending step. An `ADJUSTER` step is decided only by the claim's assigned adjuster; an `OPS_MANAGER` step not by the preparer; amounts above the approver's settlement authority are refused |
| GET | `/claims/:id/approvals` · `/approvals?type&decision&mine` | Immutable decision history (`type`: `RESERVE`, `EVALUATION`, `CLOSURE`, `SETTLEMENT`) |

```http
POST /api/v1/reserves/{id}/review          (Claims Manager with $50,000 reserve authority)
{ "decision": "APPROVED" }

403 { "error": { "code": "APPROVAL_LIMIT_EXCEEDED", "message": "$120,000.00 exceeds your reserve authority of $50,000.00. Refer this reserve to a manager with higher authority." } }
```

Settlement approval routing: the first step requires `ADJUSTER` (the claim's assigned adjuster) when the amount is within the adjuster settlement authority for the claim's segment, otherwise `OPS_MANAGER`. `GET /settlements/queue` is open to adjusters (settlements on their assigned claims), Claims Managers and Compliance & Security.

## Closure and recovery

| Method | Path | Notes |
|---|---|---|
| GET | `/claims/:id/closure-requests` | |
| POST | `/claims/:id/closure-requests` | Assigned adjuster, claim `PAID` or `REJECTED`: `{ reason }` |
| POST | `/closure-requests/:id/decision` | Claims Manager (not the requester): `{ decision: "APPROVED"|"REJECTED", comment? }`. Approval closes the claim through the workflow and releases any remaining reserve |
| GET | `/claims/:id/recoveries` | |
| POST | `/claims/:id/recoveries` | `{ type: "SUBROGATION"|"SALVAGE", targetParty?, description?, expectedAmount?, deadline? }` |
| PATCH | `/recoveries/:id` | `{ status?, recoveredAmount?, expectedAmount?, targetParty?, description?, deadline? }` |

## Compliance

| Method | Path | Notes |
|---|---|---|
| GET | `/compliance/queue?status` | |
| GET | `/claims/:id/compliance-reviews` | History |
| POST | `/claims/:id/compliance-reviews` | `{ placeHold, notes, riskFlags[] }` — opens a review at any active stage. Risk flags use the `fraud_reason_codes` taxonomy (`{ code, severity, note?, resolved }`); open flags recompute the claim fraud score |
| PATCH | `/compliance-reviews/:id` | `{ checklist, riskFlags, evidence, decisionNotes, escalationNotes }` |
| POST | `/compliance-reviews/:id/decision` | `{ decision: "CLEAR"|"HOLD"|"EXCEPTION"|"ESCALATE", notes?, exceptionReason? }` |

## Payments (simulated adapter)

| Method | Path | Notes |
|---|---|---|
| GET | `/payments?status&search` | Payee account masked; rows include `open_blocks` and `payee_verification` |
| GET | `/payments/:id` | Payment, payee (verification, last bank-detail change, duplicate-account matches), approval steps, blocks, attempts, claim, hold flag, `canIssue` |
| GET | `/payments/:id/beneficiary` | Payment Operators only; decrypts the bank details; audited reveal |
| POST | `/payments/:id/issue` | **Requires `Idempotency-Key` header.** Refused for the user who approved the settlement and while any block is open |
| POST | `/payments/:id/resolve-block` | Failed payment → pending: `{ resolution }`. Other open blocks must be cleared first |
| PATCH | `/payments/:id/beneficiary` | Payment Operator: `{ beneficiaryName, beneficiaryBank?, beneficiaryAccount, reason }`. The payee becomes `UNVERIFIED` and a `BANK_DETAILS_CHANGED` block opens |
| GET | `/claims/:id/payee` | The payee the claim will be paid to: masked account, verification status, who entered and verified it, and `canRecord` / `canVerify` for the caller |
| PUT | `/claims/:id/payee` | Claims Operations Manager, during intake (before settlement): `{ payeeName, bankName?, accountNumber, reason }`. Encrypted; the payee becomes `UNVERIFIED` and the claim cannot leave intake until it is verified |
| POST | `/payees/:id/verify` | Claims Operations Manager or Payment Operator who did not enter the details: `{ notes? }`. Clears payee blocks |
| POST | `/payments/:id/reconcile` | `{ reconciliationReference, notes? }` |
| GET | `/payments/reconciliation/summary` | |
| GET | `/payments/mine` · `/claims/:id/payment-status` | Client-safe settlement and payment status |

```http
POST /api/v1/payments/{id}/issue
Idempotency-Key: pay-3f8a1c…

200 { "data": { "replayed": false, "payment": { "status": "PAID", "portal_reference": "SIM-TXN-7010B0F7F85D", "is_simulated": true, … },
                "attempt": { "attempt_no": 1, "status": "SUCCEEDED" } },
      "meta": { "replayed": false, "simulated": true } }
```

Repeating the same key returns the same result with `replayed: true`. A different key while the payment is processing or paid returns `409 PAYMENT_NOT_PENDING`. A successful issue adds a `PAYMENT_ISSUED` entry that reduces the reserve.

## Notifications, reports, audit, admin

| Method | Path | Notes |
|---|---|---|
| GET | `/notifications?unread` | Own in-app notifications (`is_read`, `read_at`); `meta.unread`. Email deliveries are separate rows |
| GET | `/notifications/unread-count` | |
| POST | `/notifications/:id/read` · `/notifications/read-all` | |
| GET | `/reports/summary?from&to&granularity=day|week|month` | All datasets for your scope, including `claimsByStage`, `slaAttainment` and `cycleTime` |
| GET | `/audit-logs?claimId&actorId&actorType&entityType&action&from&to` | Compliance & Security (all), Claims Managers and Data Engineers (scoped). Rows carry `occurred_at`, `actor_type` (`USER`/`AGENT`/`SYSTEM`), `before`, `after`, `ip`, `seq`, `hash` |
| GET | `/audit-logs/verify` | Compliance & Security. Recomputes the hash chain: `{ intact, rowsChecked, problems[] }` |
| GET | `/claims/:id/audit` | |
| GET | `/admin/users?search&role` · POST `/admin/users` | Compliance & Security. Create: `{ email, fullName, phone?, password, roles: [codes], reserveLimit?, settlementLimit?, region?, teamId? }` |
| PATCH | `/admin/users/:id` | `{ isActive }` |
| POST | `/admin/users/:id/roles` | `{ roleCode, reserveLimit?, settlementLimit?, region?, teamId? }` — never on yourself |
| PUT | `/admin/users/:id/attributes` | Authority overrides and attributes: `{ reserveLimit?, settlementLimit?, region?, teamId? }` (`null` = role default) |
| DELETE | `/admin/users/:id/roles/:roleCode` | |
| GET | `/admin/roles` · `/admin/system` | |
| POST | `/admin/jobs/overdue-sweep` | Compliance & Security, Claims Managers. Runs the overdue-task and SLA sweeps: `{ overdue, notified, sla: { checked, escalated } }` |

## Configuration

| Method | Path | Notes |
|---|---|---|
| GET | `/config/segments` | Active and proposed `segment_config` rows |
| POST | `/config/segments` | Claims Manager or Compliance & Security: `{ segment, configKey, configValue, notes? }`. Keys: `required_artifacts`, `sla_hours`, `severity_thresholds`, `fraud_review_threshold`, `unclaimed_task_escalation_hours`; the value is validated |
| POST | `/config/segments/:id/decision` | A different person: `{ decision: "APPROVED"|"REJECTED", notes? }`. Approval retires the active version |
| GET | `/config/authority-limits` | Role defaults by limit type and segment |
| GET | `/config/fraud-reason-codes` | Weighted taxonomy |

## Integrations

| Method | Path | Notes |
|---|---|---|
| GET | `/integrations/runs?source&status` | Data Engineer, Compliance & Security |
| POST | `/integrations/runs` | Data Engineer: `{ sourceSystem, status, recordsIn, recordsFailed, startedAt?, finishedAt?, checkpoint?, error? }` |
| GET | `/integrations/xref?claimId&status` | Claim cross-references |
| POST | `/integrations/xref` | `{ claimId, sourceSystem, externalClaimId }` (manual match) |
| GET/PUT | `/integrations/source-precedence` | PUT `{ fieldGroup, sourceSystem, rank, rule }` |

## Customer records (Compliance & Security only)

Every other role receives `403`. All views, exports and downloads are written to the audit log.

| Method | Path | Notes |
|---|---|---|
| GET | `/customers?search&policyType&policyStatus&hasOpenClaims&status&possibleDuplicate&sort&direction&page&pageSize` | `search` matches name, email, customer ID, phone digits and policy numbers. `sort`: `name`, `created_at`, `last_claim_at`, `claim_count`, `last_activity_at`. `meta.retentionYears` |
| GET | `/customers/export?…same filters` | CSV (max 5,000 rows; `X-Export-Truncated` header). Cells starting with `= + - @` are prefixed to prevent spreadsheet formula injection |
| GET | `/customers/:id` | `{ customer, policies, claims, documents, consents, possibleDuplicates, retention }`. Payout accounts are masked; drafts and internal evidence are excluded |
| GET | `/customers/:id/documents/:documentId/download?disposition` | Streams a customer document after checking it belongs to that customer |

```json
{ "data": [{ "id": "6246b58b-…", "full_name": "Alice Thornton", "email": "customer.alice@demo.harborpoint.test",
             "phone": "+1 555 0101", "policy_numbers": "HP-MOT-100231, HP-PRP-200001", "policy_count": 3,
             "claim_count": 6, "open_claim_count": 4, "last_claim_at": "2026-10-14T…",
             "last_activity_at": "2026-10-20T…", "retain_until": "2033-10-20T…", "possible_duplicate": false }],
  "meta": { "page": 1, "pageSize": 25, "total": 3, "totalPages": 1, "retentionYears": 7 } }
```

## Automation (Claims Operations Managers, Claims Managers and Document Reviewers; Compliance & Security read-only)

AI endpoints return `503 AI_NOT_CONFIGURED` with `details.setup` (instructions) when `AI_PROVIDER=none`. They never return placeholder results. AI errors use `AI_TIMEOUT` (504), `AI_UNAVAILABLE` / `AI_RATE_LIMITED` (503), `AI_INVALID_OUTPUT` / `AI_PROVIDER_ERROR` / `AI_POLICY_VIOLATION` (502) and `AI_REFUSED` (422); `details.retryable` says whether trying again can help, and `details.runId` points at the logged failed run.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/automation/status` | `automation.view` | `{ configured, provider, model, setup[] }` |
| GET | `/claims/:id/automation/document-checklist` | `automation.documentChecklist` | Rule-based: `required[]` (state `ACCEPTED`, `PENDING_REVIEW`, `REJECTED`, `MISSING`, open request), `requestable[]`, `suggestedActions[]`, `openDraft` |
| POST | `/claims/:id/automation/reminder-drafts` | `automation.reminders` | `{ categories? }` (document types) → client draft (status `DRAFT`). Nothing is sent. `409 DRAFT_EXISTS`, `409 NOTHING_TO_REQUEST` |
| POST | `/automation/reminders/:id/approve` | `automation.reminders` | `{ message? }` (edited text). Creates one artifact request per document type and one notification to the claimant |
| POST | `/automation/reminders/:id/discard` | `automation.reminders` | |
| GET | `/claims/:id/automation/reminders` | `automation.view` | Reminder history for a claim |
| GET | `/automation/reminders?status&audience&type` | `automation.view` | Within your claim scope |
| POST | `/automation/reminders/sweep` | `automation.reminders` | Runs the deadline sweep now: `{ claimsChecked, remindersSent, draftsPrepared }` |
| POST | `/documents/:id/extractions` | `automation.extract` | The intake-parser agent reads the document. The run is stored in `ai_runs` (`prompt_version`, `input_hash`, numeric `confidence`, `human_decision: PENDING`) and audited with `actor_type: AGENT`; the claim is **not** changed |
| GET | `/claims/:id/automation/extractions` | `automation.view` | |
| POST | `/automation/extractions/:id/apply` | `automation.applyExtraction` | `{ fields: ["estimated_loss", …] }` — only fields marked `applicable`, only while the claim is between Submitted and Investigation. Audited as `CLAIM_UPDATED_FROM_EXTRACTION` |
| POST | `/automation/extractions/:id/discard` | `automation.applyExtraction` | |
| GET | `/claims/:id/automation/summary` | `automation.view` | `{ facts, ai, disclaimer, aiStatus }` — `facts` comes from the database; `ai` is the latest stored summary (with `stale`) or `null` |
| POST | `/claims/:id/automation/summary` | `automation.summarize` | Generates a new AI summary |

Extraction field (one per entry in `result.fields`):

```json
{ "key": "estimated_loss", "label": "Loss amount", "claimField": "estimated_loss",
  "value": 13250, "confidence": 0.72, "confidence_band": "medium", "needs_confirmation": true,
  "source": { "page": 2, "quote": "Total $13,250.00" },
  "valid": true, "issue": null, "currentValue": "12800.00", "matchesCurrent": false, "applicable": true }
```
