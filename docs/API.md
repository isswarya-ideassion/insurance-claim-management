# API Reference — `/api/v1`

Base URL in development: `http://localhost:4000/api/v1` (the web app proxies `/api` to it).

## Conventions

**Authentication.** Every endpoint except `/health` and `/auth/mock/*` requires `Authorization: Bearer <access token>`. In Supabase mode the token is the Supabase Auth access token obtained by the browser; in mock mode it comes from `POST /auth/mock/login`.

**Responses.**

```json
{ "data": { ... }, "meta": { "page": 1, "pageSize": 20, "total": 42, "totalPages": 3 } }
```

```json
{ "error": { "code": "WORKFLOW_GUARD_FAILED", "message": "Cannot move claim HPC-2026-000102 to Document Review: Policy verification must be recorded as passed.", "details": { "failures": [ ... ] }, "requestId": "6f0c…" } }
```

Every response carries an `x-request-id` header, also stored on audit records.

**Status codes.** `400` malformed request · `401` not authenticated · `403` authenticated but not permitted (codes such as `TRANSITION_NOT_PERMITTED`, `APPROVAL_LIMIT_EXCEEDED`, `SELF_APPROVAL_FORBIDDEN`, `CONFLICT_OF_INTEREST`) · `404` not found **or outside your scope** (claim existence is never disclosed) · `409` business-rule conflict (`WORKFLOW_GUARD_FAILED`, `POSSIBLE_DUPLICATE`, `COMPLIANCE_HOLD_ACTIVE`, `PAYMENT_NOT_PENDING`, …) · `413` upload too large · `415` unsupported file type · `422` validation error or invalid transition · `429` rate limited.

**Pagination.** `page` (default 1) and `pageSize` (default 20, max 100).

---

## Health & authentication

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ status, mode: "mock"|"supabase", mockMode, simulatedPayments }` |
| GET | `/auth/me` | Profile, roles, approval limit, permissions, visible claim tabs |
| PATCH | `/auth/me` | `{ fullName?, phone? }` — roles cannot be changed here |
| POST | `/auth/mock/login` | Mock mode only. `{ email, password }` → `{ accessToken, expiresIn }` |
| POST | `/auth/mock/register` | Mock mode only. Grants `CUSTOMER` only |
| POST | `/auth/mock/forgot-password` | Mock mode only. Reset link is written to the server log (`delivery: "LOGGED_DEV"`) |
| POST | `/auth/mock/reset-password` | Mock mode only. `{ token, password }`; tokens are single-use |

In Supabase mode, registration, login and password recovery use Supabase Auth directly from the browser (anon key); `/auth/mock/*` returns `404 MOCK_AUTH_DISABLED`.

```http
POST /api/v1/auth/mock/login
{ "email": "ops.olivia@demo.harborpoint.test", "password": "HarborDemo!2026" }

200 { "data": { "accessToken": "eyJ…", "expiresIn": 28800, "tokenType": "bearer" } }
```

## Policies

| Method | Path | Notes |
|---|---|---|
| GET | `/policies?search&status&type` | Customers: own policies. Staff: all. Payout account is masked |
| GET | `/policies/:id` | |
| POST | `/policies/eligibility` | `{ policyNumber, incidentAt?, claimType?, incidentCategory?, estimatedLoss? }` → `{ eligible, reasons[], checks{}, policy }` |

## Claims

| Method | Path | Notes |
|---|---|---|
| GET | `/claims` | Filters: `search`, `status` (CSV), `claimType`, `priority`, `assigneeId` (`uuid`/`me`/`unassigned`), `needsAdjuster`, `overdue`, `escalated`, `from`, `to`, `sort`, `order` |
| GET | `/claims/stats` | Dashboard counts within your scope |
| POST | `/claims` | Create draft (customer, or operations on behalf with `policyNumber`) |
| GET | `/claims/:id` | Customer projection or staff detail (policy, eligibility, current task, checklist, counts, permissions) |
| PATCH | `/claims/:id` | Draft fields (claimant) or `{ priority, dueDate }` (operations/manager) |
| DELETE | `/claims/:id` | Discard draft (recorded as withdrawn) |
| POST | `/claims/:id/submit` | `{ submissionKey?, confirmSeparateClaim? }` or `Idempotency-Key` header |
| GET | `/claims/:id/transitions` | Transitions you may attempt now, with blocking guards |
| POST | `/claims/:id/transitions` | `{ toStatus, reason?, customerMessage? }` |
| POST | `/claims/:id/verify-policy` | `{ verified, notes? }` |
| PATCH | `/claims/:id/intake-checklist` | `{ items: { POLICY_ACTIVE: true, … } }` |
| POST | `/claims/:id/escalate` | `{ reason }` |
| POST | `/claims/:id/document-exception` | Manager. `{ reason }` |
| GET/POST | `/claims/:id/notes` | `{ body, visibility: "INTERNAL"|"CUSTOMER" }` |
| GET | `/claims/:id/timeline` | Merged activity (customer-safe for claimants) |

```http
POST /api/v1/claims
{ "policyNumber": "HP-MOT-100231", "incidentAt": "2026-10-15T10:30:00Z", "incidentLocation": "Harbor Road",
  "incidentCategory": "COLLISION", "incidentDescription": "Another car merged into my lane…",
  "estimatedLoss": 1850, "affectedAsset": "2023 Volvo XC40", "contactName": "Alice Thornton",
  "contactPhone": "+1 555 0101", "contactEmail": "alice@example.test", "declarationAccepted": true, "draftStep": 6 }

201 { "data": { "id": "…", "status": "DRAFT", "claim_number": null, … } }
```

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
      "message": "Claim HPC-2026-000101 cannot move from Submitted to Paid. Permitted next statuses: Policy Verification, On Hold, Withdrawn.",
      "details": { "from": "SUBMITTED", "to": "PAID", "allowed": ["POLICY_VERIFICATION", "ON_HOLD", "WITHDRAWN"] } } }
```

## Assignments

| Method | Path | Notes |
|---|---|---|
| GET | `/claims/:id/assignments` | Full history |
| POST | `/claims/:id/assignments` | `{ assigneeId, assignmentRole: "OPERATIONS_OWNER"|"DOCUMENT_REVIEWER"|"ADJUSTER", reason? }` — reason required when reassigning. Assigning an adjuster in *Adjuster Assignment* starts the investigation |
| GET | `/assignments/assignees?role=CLAIMS_ADJUSTER` | Eligible staff with active-claim counts |
| GET | `/assignments/workload` | Team workload (operations, managers, admins, auditors) |

## Documents & information requests

| Method | Path | Notes |
|---|---|---|
| GET | `/claims/:id/documents` | Customers do not see internal evidence categories |
| POST | `/claims/:id/documents` | `multipart/form-data`: `file`, `category`, `informationRequestId?`, `replacesDocumentId?` — PDF/JPEG/PNG/WebP, ≤ 10 MB, content-sniffed |
| GET | `/documents/:id/download?disposition=inline|attachment` | Streams the file after an access check; `Cache-Control: private, no-store`; audited |
| GET | `/documents/:id/versions` | |
| GET | `/documents/review-queue?status&mine&category` | Reviewers and managers |
| POST | `/documents/:id/review` | `{ decision: "ACCEPT"|"REJECT", comment?, rejectionReason? }` |
| POST | `/documents/:id/assign-reviewer` | `{ reviewerId }` |
| GET/POST | `/claims/:id/information-requests` | `{ requestType: "DOCUMENT"|"INFORMATION", documentCategory?, message, dueAt? }` |
| GET | `/information-requests?status` | Requests across claims in your scope |
| POST | `/information-requests/:id/respond` | Claimant. `{ responseText }` (document requests are answered by uploading) |
| POST | `/information-requests/:id/close` | Staff |

```http
POST /api/v1/documents/{id}/review
{ "decision": "REJECT", "rejectionReason": "Invoice is not itemised" }

200 { "data": { "document": { "status": "REJECTED", … }, "claimStatus": "DOCUMENTS_REQUIRED" } }
```

## Tasks

| Method | Path | Notes |
|---|---|---|
| GET | `/tasks?view=mine|team&status&overdue&claimId` | |
| POST | `/tasks` | `{ claimId?, title, description?, taskType, priority, isMandatory, assigneeId?, assignedRole?, dueAt? }` |
| PATCH | `/tasks/:id` | `{ status?, assigneeId?, dueAt?, priority? }` — only managers cancel mandatory tasks |
| GET | `/claims/:id/tasks` | |

## Assessments, reserves, settlements, approvals

| Method | Path | Notes |
|---|---|---|
| GET | `/claims/:id/assessments` | All versions |
| POST | `/claims/:id/assessments` | Assigned adjuster; new version carries previous content |
| PATCH | `/assessments/:id` | Draft only: `{ checklist, findings, evidence[], estimatedLoss, recommendedSettlement, recommendation, internalNotes }` |
| POST | `/assessments/:id/submit` | `{ reserveAmount, reserveReason? }` (omit for `DENY`) |
| POST | `/assessments/:id/return` | Manager. `{ comment }` |
| GET | `/claims/:id/reserves` · `/reserves/queue` | Pending items include `canDecide`, `canApprove`, `reason` for the caller |
| POST | `/reserves/:id/decision` | `{ decision: "APPROVED"|"REJECTED"|"RETURNED", comments? }` |
| GET | `/claims/:id/settlements` · `/settlements/queue` | |
| POST | `/settlements/:id/decision` | Approval creates the payment request |
| GET | `/claims/:id/approvals` · `/approvals?type&decision&mine` | Immutable decision history |

```http
POST /api/v1/reserves/{id}/decision          (manager with a $50,000 limit)
{ "decision": "APPROVED" }

403 { "error": { "code": "APPROVAL_LIMIT_EXCEEDED", "message": "$120,000.00 exceeds your approval limit of $50,000.00. Refer this request to a manager with higher authority." } }
```

## Compliance

| Method | Path | Notes |
|---|---|---|
| GET | `/compliance/queue?status` | |
| GET | `/claims/:id/compliance-reviews` | History |
| POST | `/claims/:id/compliance-reviews` | `{ placeHold, notes, riskFlags[] }` — opens a review at any active stage |
| PATCH | `/compliance-reviews/:id` | `{ checklist, riskFlags, evidence, decisionNotes, escalationNotes }` |
| POST | `/compliance-reviews/:id/decision` | `{ decision: "CLEAR"|"HOLD"|"EXCEPTION"|"ESCALATE", notes?, exceptionReason? }` |

## Payments (simulated adapter)

| Method | Path | Notes |
|---|---|---|
| GET | `/payments?status&search` | Beneficiary account masked |
| GET | `/payments/:id` | Payment, attempts, settlement approval, claim, hold flag |
| GET | `/payments/:id/beneficiary` | Payment operations only; audited reveal |
| POST | `/payments/:id/process` | **Requires `Idempotency-Key` header** |
| POST | `/payments/:id/retry` | Failed → pending |
| PATCH | `/payments/:id/beneficiary` | `{ beneficiaryName, beneficiaryBank?, beneficiaryAccount, reason }` (pending or failed only) |
| POST | `/payments/:id/reconcile` | `{ reconciliationReference, notes? }` |
| GET | `/payments/reconciliation/summary` | |
| GET | `/payments/mine` · `/claims/:id/payment-status` | Customer-safe settlement/payment status |

```http
POST /api/v1/payments/{id}/process
Idempotency-Key: pay-3f8a1c…

200 { "data": { "replayed": false, "payment": { "status": "PAID", "transaction_reference": "SIM-TXN-7010B0F7F85D", "is_simulated": true, … },
                "attempt": { "attempt_no": 1, "status": "SUCCEEDED" } },
      "meta": { "replayed": false, "simulated": true } }
```

Repeating the same key returns the same result with `replayed: true`. A different key while the payment is processing or paid returns `409 PAYMENT_NOT_PENDING`.

## Notifications, reports, audit, admin

| Method | Path | Notes |
|---|---|---|
| GET | `/notifications?unread` | Own notifications; `meta.unread` |
| GET | `/notifications/unread-count` | |
| POST | `/notifications/:id/read` · `/notifications/read-all` | |
| GET | `/reports/summary?from&to&granularity=day|week|month` | All report datasets for your scope |
| GET | `/audit-logs?claimId&actorId&entityType&action&from&to` | Auditors, compliance, managers, admins |
| GET | `/claims/:id/audit` | |
| GET | `/admin/users?search&role` · POST `/admin/users` | Data admin |
| PATCH | `/admin/users/:id` | `{ isActive }` |
| POST | `/admin/users/:id/roles` | `{ roleCode, approvalLimit? }` — never on yourself |
| DELETE | `/admin/users/:id/roles/:roleCode` | |
| GET | `/admin/roles` · `/admin/system` | |
| POST | `/admin/jobs/overdue-sweep` | Admins and managers |

## Customer records (`CUSTOMER_RECORDS_ADMIN` only)

Every other role, including data administrators and auditors, receives `403`. All views, exports and downloads are written to the audit log.

| Method | Path | Notes |
|---|---|---|
| GET | `/customers?search&policyType&policyStatus&hasOpenClaims&status&possibleDuplicate&sort&direction&page&pageSize` | `search` matches name, email, customer ID, phone digits and policy numbers. `sort`: `name`, `created_at`, `last_claim_at`, `claim_count`, `last_activity_at`. `meta.retentionYears` |
| GET | `/customers/export?…same filters` | CSV (max 5,000 rows; `X-Export-Truncated` header). Cells starting with `= + - @` are prefixed to prevent spreadsheet formula injection |
| GET | `/customers/:id` | `{ customer, policies, claims, documents, possibleDuplicates, retention }`. Payout accounts are masked; drafts and internal evidence are excluded |
| GET | `/customers/:id/documents/:documentId/download?disposition` | Streams a customer document after checking it belongs to that customer |

```json
{ "data": [{ "id": "6246b58b-…", "full_name": "Alice Thornton", "email": "customer.alice@demo.harborpoint.test",
             "phone": "+1 555 0101", "policy_numbers": "HP-MOT-100231, HP-PRP-200001", "policy_count": 3,
             "claim_count": 6, "open_claim_count": 4, "last_claim_at": "2026-10-14T…",
             "last_activity_at": "2026-10-20T…", "retain_until": "2033-10-20T…", "possible_duplicate": false }],
  "meta": { "page": 1, "pageSize": 25, "total": 3, "totalPages": 1, "retentionYears": 7 } }
```

## Automation (claims officers and managers; auditors read-only)

AI endpoints return `503 AI_NOT_CONFIGURED` with `details.setup` (instructions) when `AI_PROVIDER=none`. They never return placeholder results. AI errors use `AI_TIMEOUT` (504), `AI_UNAVAILABLE` / `AI_RATE_LIMITED` (503), `AI_INVALID_OUTPUT` / `AI_PROVIDER_ERROR` / `AI_POLICY_VIOLATION` (502) and `AI_REFUSED` (422); `details.retryable` says whether trying again can help, and `details.runId` points at the logged failed run.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/automation/status` | `automation.view` | `{ configured, provider, model, setup[] }` |
| GET | `/claims/:id/automation/document-checklist` | `automation.documentChecklist` | Rule-based: `required[]` (state `ACCEPTED`, `PENDING_REVIEW`, `REJECTED`, `MISSING`, open request), `requestable[]`, `suggestedActions[]`, `openDraft` |
| POST | `/claims/:id/automation/reminder-drafts` | `automation.reminders` | `{ categories? }` → customer draft (status `DRAFT`). Nothing is sent. `409 DRAFT_EXISTS`, `409 NOTHING_TO_REQUEST` |
| POST | `/automation/reminders/:id/approve` | `automation.reminders` | `{ message? }` (edited text). Creates one document request per category and one notification to the claimant |
| POST | `/automation/reminders/:id/discard` | `automation.reminders` | |
| GET | `/claims/:id/automation/reminders` | `automation.view` | Reminder history for a claim |
| GET | `/automation/reminders?status&audience&type` | `automation.view` | Within your claim scope |
| POST | `/automation/reminders/sweep` | `automation.reminders` | Runs the deadline sweep now: `{ claimsChecked, remindersSent, draftsPrepared }` |
| POST | `/documents/:id/extractions` | `automation.extract` | AI reads the document. Result is stored with `review_status: PENDING_REVIEW`; the claim is **not** changed |
| GET | `/claims/:id/automation/extractions` | `automation.view` | |
| POST | `/automation/extractions/:id/apply` | `automation.applyExtraction` | `{ fields: ["estimated_loss", …] }` — only fields marked `applicable`, only while the claim is between Submitted and Investigation. Audited as `CLAIM_UPDATED_FROM_EXTRACTION` |
| POST | `/automation/extractions/:id/discard` | `automation.applyExtraction` | |
| GET | `/claims/:id/automation/summary` | `automation.view` | `{ facts, ai, disclaimer, aiStatus }` — `facts` comes from the database; `ai` is the latest stored summary (with `stale`) or `null` |
| POST | `/claims/:id/automation/summary` | `automation.summarize` | Generates a new AI summary |

Extraction field (one per entry in `result.fields`):

```json
{ "key": "estimated_loss", "label": "Loss amount", "claimField": "estimated_loss",
  "value": 13250, "confidence": "medium", "source": { "page": 2, "quote": "Total $13,250.00" },
  "valid": true, "issue": null, "currentValue": "12800.00", "matchesCurrent": false, "applicable": true }
```
