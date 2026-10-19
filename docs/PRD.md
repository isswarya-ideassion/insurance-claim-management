# Product Requirements — HarborPoint Claims Operations Hub

## 1. Purpose

HarborPoint General Insurance needs a single system to receive, process and settle insurance claims. Policyholders submit and track claims online; internal teams move each claim through a controlled workflow with clear ownership, auditable decisions and enforced financial controls.

## 2. Goals

1. Customers can submit a complete claim in one sitting or over several sessions, and always see where their claim stands.
2. Every claim follows a defined workflow; no one can skip a stage or bypass a control.
3. Financial decisions (reserves, settlements, payments) are separated, authorized by limit, and never self-approved.
4. Compliance can stop any claim from being settled or paid until it is cleared.
5. Every change is attributable and permanently recorded.
6. Management can see workload, bottlenecks and outcomes from live data.

Non-goals for the MVP: real bank payments, real email delivery, policy administration (policies are reference data), mobile apps.

## 3. Roles

| Role | Responsibilities | Claim scope |
|---|---|---|
| Customer | Register, view own policies, submit and track own claims, upload documents, answer requests | Own claims only |
| Claims Operations | Intake, policy verification, intake checklist, routing, assignment, tasks, escalation, closure | All submitted claims |
| Document Reviewer | Review queue, accept/reject documents, request missing documents | Claims in document stages or assigned to them |
| Claims Adjuster | Investigate assigned claims, record assessment, request reserve | Claims they are (or were) assigned to |
| Claims Manager | Assign adjusters, approve reserves and settlements within limit, return assessments, record document exceptions, reopen claims | All submitted claims |
| Payment Operations | Process approved payments, handle failures, reconcile | Payment-stage claims |
| Compliance Officer | Compliance reviews, risk flags, holds, clearances, exceptions | Compliance-stage claims and claims they reviewed |
| Data Administrator | Manage users and role grants; view reports and audit | No claim content |
| Auditor | Read-only access to claims, decisions, payments, reports and audit log | All submitted claims (read-only) |

Users can hold several roles and switch workspace from the header; only roles granted by an administrator are available.

## 4. Customer portal

Screens: dashboard, My Policies, My Claims, New Claim, Claim Details, document upload, information requests, timeline, settlement & payment status, notification center, profile.

**New Claim wizard** (six steps; each step is saved as a server-side draft):

1. Policy — choose from the customer's own policies (lapsed/expired shown but not selectable); policy type and insured name.
2. Incident — date and time (not in the future), location, category (filtered by policy type), description (≥ 20 characters).
3. Loss — estimated loss, affected property or asset.
4. Documents — upload against categories; required documents for the policy type are listed.
5. Contact — name, phone, email (pre-filled from profile).
6. Review & submit — summary, missing-document warning, declaration and consent (mandatory).

Rules:
- Policy ownership, status, period, type/category coverage and sum insured are validated **against the database** on submission.
- A unique reference `HPC-<year>-<6 digits>` is generated at submission.
- Double-submission protection: each draft gets an idempotency key; resubmitting returns the same claim.
- Likely duplicates (same policy and incident category within 24 hours of an existing claim) require explicit confirmation; confirmed claims are flagged for intake.
- Customers never see internal statuses: holds and compliance stages display as "Under review" / "Being assessed".

## 5. Claim workflow

Statuses: `DRAFT, SUBMITTED, POLICY_VERIFICATION, DOCUMENTS_REQUIRED, DOCUMENT_REVIEW, ADJUSTER_ASSIGNMENT, INVESTIGATION, RESERVE_APPROVAL, COMPLIANCE_REVIEW, SETTLEMENT_APPROVAL, PAYMENT_PENDING, PAYMENT_FAILED, PAID, CLOSED, REJECTED, WITHDRAWN, ON_HOLD, REOPENED`.

The happy path:

```
DRAFT → SUBMITTED → POLICY_VERIFICATION → DOCUMENT_REVIEW → ADJUSTER_ASSIGNMENT → INVESTIGATION
      → RESERVE_APPROVAL → COMPLIANCE_REVIEW → SETTLEMENT_APPROVAL → PAYMENT_PENDING → PAID → CLOSED
```

All 66 permitted transitions, the roles allowed to execute each, and their guards are defined once in `shared/workflow.js` and enforced by the API's central workflow service and by a database trigger (generated migration). Key guards:

| Transition | Guard |
|---|---|
| Draft → Submitted | Policy eligible; declaration accepted |
| Policy verification → Document review | Policy verified; intake checklist complete |
| Document review → Adjuster assignment | All required documents accepted, or a manager-recorded document exception |
| Adjuster assignment → Investigation | Adjuster assigned (assigning an adjuster triggers this automatically) |
| Investigation → Reserve approval | Assessment submitted; reserve pending (adjuster only) |
| Reserve approval → Compliance review | Reserve approved |
| Compliance review → Settlement approval | Compliance cleared or exception approved; no active hold |
| Settlement approval → Payment pending | Settlement approved; no active hold |
| Payment pending → Paid / Payment failed | System only (payment service) |
| Paid → Closed | Payment completed; no open mandatory tasks; no pending approvals; no active hold |
| Rejected / Withdrawn → Closed | Permitted closure outcomes; open tasks and requests are cancelled |
| Any active status → On hold | Reason required; resume only to the held-from status |

Every claim carries: current status, status history, owner/reviewer/adjuster, current task, priority (auto-set from estimated loss, adjustable), SLA due date per status, internal notes, customer-visible updates and audit history. Invalid transitions return `422 INVALID_TRANSITION` listing permitted next statuses; guard failures return `409 WORKFLOW_GUARD_FAILED` with each failing condition.

## 6. Operations

Dashboard KPIs: total, newly submitted, awaiting verification, awaiting documents, under investigation, awaiting approval, awaiting payment, overdue tasks, escalated, closed. Claims queue with search (claim number, claimant name, policy number), filters (status, type, priority, assignee, submitted date range, overdue, escalated), sorting and pagination. Claim workspace with intake checklist, policy verification, assignment/reassignment (reason required), tasks, notes, escalation (three levels, notifies managers) and activity timeline.

## 7. Document review

Review queue (pending/accepted/rejected, category, "assigned to me"), secure preview/download streamed through the API, accept/reject with comments, reviewer assignment, version tracking (replacements create a new version and supersede the old), review timestamps and audit records. Rejection automatically notifies the claimant, opens a missing-document request and creates a follow-up task, and returns a claim in document review to *Documents Required*. Reviewers cannot review documents they uploaded. A claimant upload that satisfies all open document requests returns the claim to review automatically.

## 8. Investigation and assessment

Adjusters see their assigned claims, complete an investigation checklist, record findings, evidence, assessed loss, recommendation (pay full / partial / deny), recommended settlement and internal notes, then submit with a reserve request (reserve must cover the recommended settlement; settlement cannot exceed the sum insured). Managers can return an assessment for correction; the adjuster starts a new version carrying the previous content. All versions and decisions are preserved.

## 9. Approvals

Reserve approvals and settlement approvals are **separate records, endpoints and queues**. Each decision (approve / reject / return) is an immutable `approvals` row recording the approver's limit at the time. Rules enforced in API and database:
- only claims managers decide; approvals above the manager's limit are refused;
- a manager cannot decide a request they submitted;
- settlements cannot exceed the approved reserve and require beneficiary details;
- settlement approval is blocked while a compliance hold is active.

## 10. Compliance

Compliance queue, review checklist, risk flags (code, severity, note, resolved), supporting evidence, decision and escalation notes, history. Decisions: **Clear** (checklist complete, no unresolved high-severity flags), **Hold**, **Exception** (≥ 20-character justification), **Escalate** (notifies managers; remains blocking). A hold can be placed at any active stage and blocks settlement approval, payment processing and closure — enforced by workflow guards, payment service checks and database triggers. Clearing a claim in compliance review creates the settlement request and advances it.

## 11. Payments

Queue of approved settlements awaiting payment, payment detail with masked beneficiary details (full reveal restricted to payment operations and audited), attempts with failure reasons, retry after updating beneficiary details, reconciliation dashboard, payment history. Processing requires an `Idempotency-Key`; replays return the recorded result; a database compare-and-set guarantees concurrent requests process at most once. States: `PENDING → PROCESSING → PAID | FAILED`, `FAILED → PENDING` (retry), `PAID → RECONCILED`. The simulated adapter fails deterministically for accounts ending `0000` or `9999` and amounts above 1,000,000 so failure handling can be demonstrated.

## 12. Notifications

In-app notifications for submission, assignment, missing documents, document acceptance/rejection, information requests, investigation updates, approval requests and decisions, compliance holds, task assignment, overdue tasks (sweep every 15 minutes, once per due date), payment success/failure, status changes and closure. Email goes through an adapter; the development console adapter records `LOGGED_DEV`, never `SENT`.

## 13. Reports

Claims by status, type and date; average and median processing time; overdue tasks by assignee; outstanding document requests; adjuster workload; approval turnaround; payment success/failure; claim aging; team productivity. All figures come from SQL over the viewer's authorized claim scope; team-level reports are limited to operations, managers, administrators and auditors. Each chart has a table view.

## 14. Non-functional requirements

- Accessibility: labelled controls, keyboard-operable tables, dialogs and menus, visible focus, reduced-motion support, charts with table alternatives.
- Responsive layout with a collapsible sidebar and a mobile navigation drawer.
- Consistent API envelope `{ data, meta }` / `{ error: { code, message, details, requestId } }`.
- All timestamps stored in UTC; money stored as `numeric(14,2)`.
- No secrets in the frontend; placeholders only in `.env.example` files.
