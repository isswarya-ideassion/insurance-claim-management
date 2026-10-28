# Product Requirements — HarborPoint Claims Operations Hub

## 1. Purpose

HarborPoint General Insurance needs a single system to receive, process and settle insurance claims. Policyholders submit and track claims online; internal teams move each claim through a controlled workflow with clear ownership, auditable decisions and enforced financial controls.

## 2. Goals

1. Customers can submit a complete claim in one sitting or over several sessions, and always see where their claim stands.
2. Every claim follows a defined workflow; no one can skip a stage or bypass a control.
3. Financial decisions (reserves, settlements, payments) are separated, authorized by monetary authority per role and segment, and never self-approved; whoever approves a settlement cannot issue its payment.
4. Compliance can stop any claim from being settled or paid until it is cleared.
5. Every change is attributable and permanently recorded.
6. Management can see workload, bottlenecks and outcomes from live data.

Non-goals for the MVP: real bank payments, real email delivery, policy administration (policies are reference data), mobile apps.

## 3. Roles

The seven roles of the Enterprise Hub PRD plus the Claims Operations Manager ([PRD-enterprise-hub.md](PRD-enterprise-hub.md) §0.5 and §2).

| Role (code) | Responsibilities | Claim scope |
|---|---|---|
| Client (`CLIENT`) | Register (privacy notice), view own policies, submit and track own claims, upload documents, answer requests | Own claims only |
| Claims Operations Manager (`CLAIMS_OPS_MANAGER`) | Owns each new claim from submission: intake, coverage verification, intake checklist, collecting and verifying payee bank details, document routing, adjuster assignment, tasks, escalation, holds | All submitted claims; new claims are assigned to them automatically |
| Claims Manager (`OPS_MANAGER`) | Reserve reviews above adjuster authority; settlement approval above adjuster authority; denials; document exceptions; evaluation returns; closure and reopening; configuration proposals and approvals; team oversight | All submitted claims |
| Adjuster (`ADJUSTER`) | Evaluate assigned claims, set and revise reserves and approve settlements within authority, recoveries, closure requests | Claims they are (or were) assigned to |
| Document Reviewer (`DOCUMENT_REVIEWER`) | Review queue, accept/reject documents, request missing documents and information, AI extraction review | Claims in intake and document stages or assigned to them |
| Payment Operator (`PAYMENT_OPERATOR`) | Payee verification and bank-detail changes, payment issue, failures, reconciliation | Claims from settlement approval onward |
| Data Engineer (`DATA_ENGINEER`) | Integration sync runs, claim cross-references, source precedence; read-only claims, configuration, reports and pipeline audit | Submitted claims, read-only |
| Compliance & Security (`COMPLIANCE_SECURITY`) | Compliance reviews, fraud flags, holds, clearances, exceptions; users, roles and authority overrides; full audit and hash-chain verification; centralized customer records | All submitted claims |

Users can hold several roles and switch workspace from the header; only roles granted by Compliance & Security are available, and nobody can change their own roles.

## 4. Customer portal

Screens: dashboard, My Policies (with renewal requests), My Claims (filters by status, claim type and submission period; no search box), New Claim, Claim Details, document upload, information requests, timeline, settlement & payment status, notification center, profile. Amounts are Indian rupees (₹1,25,000.00); settlement and paid amounts are shown as ₹ ••••• until the customer reveals them.

**New Claim wizard** (six steps; each step is saved as a server-side draft):

1. Policy — choose from the customer's own policies (lapsed/expired shown but not selectable); policy type and insured name (read-only, taken from the policy).
2. Loss — date and time (not in the future, checked on every save), address or place, city and country, loss type (filtered by policy type), description (≥ 20 characters).
3. Amount — estimated loss, affected property or asset.
4. Documents — upload against document types; required documents for the claim type and segment are listed as Missing, Uploaded or Accepted, and the step cannot be left until each is uploaded.
5. Contact — name, Indian mobile number (+91 and 10 digits starting 6–9), email (pre-filled from profile).
6. Review & submit — summary, missing-document warning, declaration and consent (mandatory; recorded in `consents` with the notice version).

Rules:
- Policy ownership, status, period, type/category coverage and sum insured are validated **against the database** on submission.
- A unique reference `HPC-<year>-<6 digits>` is generated at submission, and the claim is assigned directly to the Claims Operations Manager with the fewest open claims, who gets the intake task and a notification. Submission also freezes a policy snapshot, creates the required artifacts from segment configuration, sets severity from the segment thresholds and starts the acknowledgement and stage SLA clocks.
- Claimant contact details are stored encrypted (`claim_parties`).
- Double-submission protection: each draft gets an idempotency key; resubmitting returns the same claim.
- Likely duplicates (same policy and loss type within 24 hours of an existing claim) require explicit confirmation; confirmed claims are flagged for intake.
- Customers never see internal statuses: holds and compliance stages display as "Under review" / "Being assessed".

**Policy renewal:** a customer can request renewal of an active, expired or lapsed policy for 6, 12 or 24 months. A Claims Operations Manager or Claims Manager completes the request on the Policy Renewals page (the policy is extended from its current expiry, or from today if it has expired) or declines it with a reason the customer sees.

## 5. Claim workflow

Statuses: `DRAFT, SUBMITTED, POLICY_VERIFICATION, DOCUMENTS_REQUIRED, DOCUMENT_REVIEW, ADJUSTER_ASSIGNMENT, INVESTIGATION, RESERVE_APPROVAL, COMPLIANCE_REVIEW, SETTLEMENT_APPROVAL, PAYMENT_PENDING, PAYMENT_FAILED, PAID, CLOSED, REJECTED, WITHDRAWN, ON_HOLD, REOPENED`.

The happy path:

```
DRAFT → SUBMITTED → POLICY_VERIFICATION → DOCUMENT_REVIEW → ADJUSTER_ASSIGNMENT → INVESTIGATION
      → [RESERVE_APPROVAL, only above adjuster authority] → COMPLIANCE_REVIEW → SETTLEMENT_APPROVAL
      → PAYMENT_PENDING → PAID → CLOSED
```

Each status belongs to one PRD lifecycle stage (`claims.stage`, derived by trigger): FNOL, coverage verification, triage & assignment, investigation & documents, reserve, evaluation & decision, settlement, payment, closure & recovery.

All 67 permitted transitions, the roles allowed to execute each, and their guards are defined once in `shared/workflow.js` and enforced by the API's central workflow service and by a database trigger (generated migration). Key guards:

| Transition | Guard |
|---|---|
| Draft → Submitted | Policy eligible; declaration accepted |
| Coverage verification → Document review | Coverage recorded as covered; intake checklist complete; payee bank details collected and verified by someone other than the person who entered them |
| Document review → Triage & assignment | All required artifacts accepted, or a manager-recorded document exception |
| Adjuster assignment → Investigation | Adjuster assigned (assigning an adjuster triggers this automatically) |
| Investigation → Compliance review | Evaluation submitted; reserve posted within the adjuster's authority (adjuster only) |
| Investigation → Reserve review | Evaluation submitted; reserve above the adjuster's authority awaits review |
| Reserve review → Compliance review | Reserve approved or modified by a Claims Manager within their authority |
| Compliance review → Settlement approval | Compliance cleared or exception approved; no active hold |
| Settlement approval → Payment pending | Every settlement approval step approved; no active hold |
| Payment pending → Paid / Payment failed | System only (payment service) |
| Paid → Closed | Claims Manager only (normally by approving the adjuster's closure request); no open blocking tasks; no pending approvals; no active hold. Remaining reserve is released |
| Rejected / Withdrawn → Closed | Permitted closure outcomes; open tasks and requests are cancelled |
| Any active status → On hold | Reason required; resume only to the held-from status |

Every claim carries: current status and stage, status history, owner/reviewer/adjuster, current task, priority (auto-set from estimated loss, adjustable), severity, fraud score (score for Claims Managers and Compliance & Security, band for adjusters), SLA clocks per stage (paused while the client owes documents or a hold is active; escalation level 1 at breach, level 2 at 1.5× target), internal notes, customer-visible updates and audit history. Invalid transitions return `422 INVALID_TRANSITION` listing permitted next statuses; guard failures return `409 WORKFLOW_GUARD_FAILED` with each failing condition.

## 6. Operations

Dashboard KPIs: total, newly submitted, awaiting verification, awaiting documents, under investigation, awaiting approval, awaiting payment, overdue tasks, escalated, closed. Claims queue with filters (stage, segment, status, type, priority, assignee, submitted date range up to today, overdue, escalated), sorting and pagination; there is no search box. Claim workspace with intake checklist, coverage verification (covered / not covered / needs review, with clause references), assignment/reassignment (reason required), tasks, notes, escalation (three levels, notifies managers) and activity timeline.

## 7. Document review

Review queue (pending/accepted/rejected, document type, "assigned to me"), secure preview/download streamed through the API, accept/reject with comments, reviewer assignment, version tracking (a replacement increments the document version; every version stays downloadable), review timestamps and audit records. Rejection automatically notifies the claimant, sets the matching artifact requirement to requested, pauses the stage clock and creates a follow-up task, and returns a claim in document review to *Documents Required*. Reviewers cannot review documents they uploaded. A claimant upload that satisfies all open document requests returns the claim to review automatically.

## 8. Evaluation and reserves

Adjusters see their assigned claims, complete an investigation checklist, record findings, evidence, loss value, liability percentage, decision (pay full / partial / deny), recommended settlement and internal notes, then submit with a reserve (the reserve must cover the recommended settlement; a settlement cannot exceed the sum insured). Claims Managers can return an evaluation for correction; the adjuster starts a new version carrying the previous content. All versions and decisions are preserved.

Reserves are a **ledger**: each change is a new row with a reason code. Within the adjuster's reserve authority (role default per segment, or a personal override) the entry is posted immediately; above it, it waits for a Claims Manager, who approves, modifies (a new `MANAGER_MODIFIED` entry), rejects or returns it within their own authority. Issued payments and closure add `PAYMENT_ISSUED` and `CLOSURE_RELEASE` entries.

## 9. Settlement approvals

A settlement is created when compliance clears the claim. It is a payment in `PENDING_APPROVAL` with ordered approval steps: the claim's assigned adjuster approves it when the amount is within the adjuster's settlement authority for the segment (15,000 personal, 30,000 commercial), otherwise a Claims Manager does. Each decision (approve / reject / return) is recorded with the approver's limit at the time. Rules enforced in API and database:
- the approver must hold the step's role and enough authority;
- an adjuster step can be decided only by the claim's assigned adjuster; a Claims Manager step not by the person who prepared the settlement;
- whoever approved the settlement cannot issue the payment, which a Payment Operator does;
- settlements cannot exceed the active reserve and need payee details;
- approval is blocked while a compliance hold is active.

Reserve, evaluation, closure and compliance decisions are `reviews` rows; together with the settlement steps they form the immutable decision history.

## 10. Compliance

Compliance queue, review checklist, fraud flags from a weighted reason-code taxonomy (code, severity, note, resolved; open flags recompute the claim fraud score), supporting evidence, decision and escalation notes, history. Decisions: **Clear** (checklist complete, no unresolved high-severity flags), **Hold**, **Exception** (≥ 20-character justification), **Escalate** (notifies managers; remains blocking). A hold can be placed at any active stage and blocks settlement approval, payment processing and closure — enforced by workflow guards, payment service checks and database triggers. Clearing a claim in compliance review creates the settlement and advances it.

## 11. Payments

Queue of approved settlements awaiting payment, payment detail with masked payee details (bank details are encrypted at rest; full reveal restricted to Payment Operators and audited), payment blocks (failure, compliance hold, unverified payee, changed bank details), payee verification by a second Payment Operator after any bank-detail change, attempts with failure reasons, resolve-and-requeue after a failure, reconciliation dashboard, payment history. Issuing requires an `Idempotency-Key`; replays return the recorded result; a database compare-and-set guarantees concurrent requests process at most once. States: `PENDING_APPROVAL → PENDING → PROCESSING → PAID | FAILED`, `FAILED → PENDING` (after resolution), `PAID → RECONCILED`. The simulated adapter fails deterministically for accounts ending `0000` or `9999` and amounts above 1,000,000 so failure handling can be demonstrated.

## 12. Notifications

In-app notifications (one row per channel) for submission, assignment, missing documents, document acceptance/rejection, information requests, investigation updates, approval requests and decisions, compliance holds, task assignment, overdue tasks (sweep every 15 minutes, once per due date), payment success/failure, SLA breaches, status changes and closure. Email goes through an adapter; the development console adapter records `LOGGED_DEV`, never `SENT`. Rejections (claim denied, document rejected, settlement, reserve or closure rejected) use their own templates and are shown with a red marker, an icon and a "Rejected" label.

## 13. Reports

Claims by status, lifecycle stage, type and date; SLA attainment by stage; FNOL-to-payment cycle time; average and median processing time; overdue tasks by assignee; outstanding document requests; adjuster workload; approval turnaround; payment success/failure; claim aging; team productivity. All figures come from SQL over the viewer's authorized claim scope; team-level reports are limited to Claims Managers and Compliance & Security. Each chart has a table view.

## 14. Centralized customer records

Centralized customer records belong to **Compliance & Security**, who can see every customer record for record keeping and future reference.

- One searchable table: name, email, customer ID, phone (digits) and policy number; filters for policy type, policy status, open claims, account status and possible duplicates; sorting and pagination.
- Detail: profile, policies (payout accounts masked), submitted claim history, customer documents (preview/download through the API), consents, possible duplicates and the retention date.
- Retention: records are kept `CUSTOMER_RECORD_RETENTION_YEARS` (default 7) after the last activity and cannot be deleted through the application. Customer creation, editing and deletion are not offered by this module.
- Duplicates: email is unique in the database (the reliable identifier). Shared phone numbers or identical names are flagged for review, not blocked or merged.
- Export (CSV) needs `customers.export`. Every view, export and download is audited.
- Enforced by API permissions (`customers.*`) and RLS; every other role is refused.

## 15. Automation for claims officers

Automation removes repetitive administration for Claims Operations Managers, Claims Managers and Document Reviewers; Compliance & Security can view it. It is not a chatbot, and it never approves, rejects or settles a claim or makes a fraud determination.

| Automation | How it works | Human control |
|---|---|---|
| A. Document extraction | AI (configurable provider, default Claude) reads a PDF or image and returns loss date, location, description, loss amount, affected asset, plus policy number and insured name for cross-checking. Output is validated against the claim model (real dates, not in the future, positive amounts, minimum lengths) and compared with the claim and policy | Values are shown with page, quote and a 0–1 confidence (below 0.8 flagged for confirmation); an authorized user selects and confirms which to save. Only then is the claim updated (audited) |
| B. Missing documents | Rule-based comparison of received documents and open requests with the required checklist for the claim type | Suggested next action; a reminder draft is prepared but never sent automatically |
| C. Claim summary | Recorded facts (loss, timeline, documents, missing information, pending actions) are assembled from the database. AI adds a short summary, next steps and points to verify | AI output is labeled, stored separately, flagged when stale, and suggestions that read as a final decision are withheld |
| D. Reminders | A scheduled sweep finds claims within `REMINDER_LEAD_HOURS` of, or past, their stage deadline and notifies the assigned owner (or the Claims Managers if unassigned). A dedupe key makes each reminder unique per claim, deadline and recipient | Internal reminders are automatic. Customer reminders are drafts until approved (the database refuses a sent customer reminder without an approver) |

AI safeguards: credentials only in server environment variables; permission and claim-scope checks before any data is read; only the document (extraction) or minimized facts without names, contact details, claim or policy numbers (summary) are sent; documents are treated as untrusted input; structured JSON output validated with Zod; timeouts and retries; every call logged in `ai_runs` (agent, prompt version, input hash, confidence, human decision) and audited with `actor_type = AGENT`, with metadata only in application logs. With `AI_PROVIDER=none`, the UI and API show setup instructions instead of results.

## 16. Non-functional requirements

- Accessibility: labelled controls, keyboard-operable tables, dialogs and menus, visible focus, reduced-motion support, charts with table alternatives.
- Responsive layout with a static, fixed-width sidebar (role navigation, no collapse) on desktop, a navigation drawer on smaller screens, and a single notification bell with unread count in the top-right header.
- Consistent API envelope `{ data, meta }` / `{ error: { code, message, details, requestId } }`.
- All timestamps stored in UTC; money stored as `numeric(14,2)`.
- No secrets in the frontend; placeholders only in `.env.example` files. Bank details and claimant contacts are encrypted with AES-256-GCM (`FIELD_ENCRYPTION_KEY`, server only).
- The audit log is append-only and hash-chained; Compliance & Security can verify the chain from the Audit log page.
