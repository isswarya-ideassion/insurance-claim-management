# Enterprise Claims Operations Hub — Product Requirements Document

**Version 1.5** · Original draft: October 21, 2026 · Revised: October 22, 2026 (1.1), October 23, 2026 (1.2), October 26, 2026 (1.3), October 27, 2026 (1.4, 1.5)
**Owner:** Mohammed Naveed · **Status:** DRAFT, awaiting sign-off · **Target delivery:** October 27, 2026

> **About this revision.** Version 1.0 was reviewed against the four requirement areas requested for this release (customer data collection and role-based access, end-to-end claim timelines, AI integration and technology stack, and security) and against the code in this repository. Sections marked **[New in 1.1]** were added; sections marked **[Updated in 1.1]** were changed. Section 0 lists every finding. Version 1.2 reduced the role model to the seven PRD roles and recorded the database schema as implemented (§0.4, §2, §5.5). Version 1.3 splits the manager persona: new claims go directly to a Claims Operations Manager, and approvals stay with the Claims Manager (§0.5, §2). Version 1.4 moves settlement approval within authority to the assigned adjuster (§0.6). Version 1.5 records the portal changes made this week: rupee amounts, Indian mobile numbers, loss city and country, policy renewal requests, claim filters, rejection notifications and masked settlement amounts (§0.7). The as-built MVP specification remains in [PRD.md](PRD.md); Appendix A maps each requirement here to its implementation status.

---

## 0. Review findings and change log **[New in 1.1]**

### 0.1 Coverage of the requested areas

| Area | Verdict on v1.0 | What was missing or incomplete | Where fixed |
|---|---|---|---|
| Customer data collection | **Missing** | No inventory of the personal data collected, at which step, for what purpose, how it is classified, who can see it or how long it is kept. No consent model beyond a passing mention of audio consent. No customer identity verification at registration. Data-subject rights covered by one line | §2A (new) |
| Role-based access | **Incomplete** | Personas do not map to the roles implemented (10 role codes in code vs. 7 personas). No intake-officer or read-only auditor persona. Compliance & Security both administers roles and is subject to them, with no second approver. The Payment Operator can approve a settlement and also issue the payment. The matrix has no rows for customer PII export, configuration changes (segment_config, authority_limits), tasks, notifications or the AI service identity | §2.1, §2.2, §2.3, §2.4 |
| End-to-end claim timelines | **Missing** | `sla_clocks` table defined, but no per-stage targets, clock start/stop/pause rules, escalation ladder or end-to-end target. "Acknowledge within minutes" is not measurable. Delivery phases have no dates | §3.10 (new), §8.1, §8.2 |
| AI integration | **Incomplete** | No model, hosting platform, effort, timeout or cost basis. Prompt contracts missing for the payee-anomaly (§3.7) and subrogation (§3.9) agents. `confidence` type undefined (number vs. band). FR-X4 fields not aligned with the implemented `ai_runs` table. No evaluation thresholds that gate release | §3.0 FR-X4, §3.7, §3.9, §6.4, §6.7 (new) |
| Technology stack | **Incomplete** | Layers named (React PWA, Node.js, PostgreSQL, AWS, Docker) but no frameworks, versions, queue, OCR engine, PWA tooling, IaC or CI. The PRD assumes AWS-native Postgres/S3/OIDC; the code runs on Supabase (Postgres, Auth, Storage). The PRD recommends TypeScript; the code is JavaScript | §6.0 (new) |
| Security | **Incomplete** | No data classification, threat model, key rotation, incident response or breach-notification process. Session lifetimes and rate limits unspecified. No controls against bank-detail changes (the most common claims-payment fraud). No service-worker/offline-cache security rules | §7.2 (expanded), §7.8 (new) |

### 0.2 Internal inconsistencies corrected

1. **Reserves DDL (§5.4) violated the §5.1 conventions.** It had no `currency`, `updated_at`, `created_by`, `updated_by`, `version` or `deleted_at`. It also defaulted `approval_status` to `posted` even when `authority_ok = false`. Corrected DDL with a CHECK constraint in §5.4.
2. **Closure authority.** §2.3 and §3.9 say only the Claims Manager closes a claim; the as-built workflow lets Claims Operations close paid claims too. Kept the PRD rule and listed it as a code change (Appendix A).
3. **Settlement approval.** §2.2 gives Payment Operators settlement approval *and* payment issuance. A new separation-of-duties rule says the approver cannot issue the same payment (§2.3).
4. **Delivery arithmetic.** v1.0 said go-live was "six days away"; at this revision five calendar days remain (Oct 22 → Oct 27), two of them a weekend.
5. **Owner name** appears as both "Mohamed Naveed" and "Mohammed Naveed". This revision uses the spelling in the core-team list; owner to confirm.
6. **FR-X4 `confidence`** was untyped. It is now a number from 0 to 1 per field, with display bands (§3.0).

### 0.3 Decisions required before build starts (owner: Mohammed Naveed, by Oct 22 EOD)

| # | Decision | Recommendation | Why it matters |
|---|---|---|---|
| D1 | Platform for go-live: keep Supabase or move to plain PostgreSQL | **Resolved (Oct 23):** PostgreSQL only. Supabase Auth and Storage are replaced by the API's own sign-in and in-database document storage; `npm run db:import-supabase` moves the existing project, keeping user passwords | One platform dependency instead of three; runs on any managed PostgreSQL (for example RDS) |
| D2 | Claude hosting: Claude API, Claude Platform on AWS, or Amazon Bedrock | Claude Platform on AWS or Bedrock, chosen by Security under open question 5. See §6.4 for the feature difference | Data-handling approval; refusal fallbacks behave differently per platform |
| D3 | Go-live scope cut line (§8.1) | Accept the "Launch" column in §8.1; everything else follows the dated post-launch plan | The full nine-stage AI-assisted scope cannot pass UAT, security and compliance sign-off by Oct 27 |
| D4 | Data Engineer persona at launch | **Resolved (1.2):** ship the role with the integration monitor (sync runs, claim cross-references, source precedence) | Pipelines are observable from day one |
| D5 | Customer Records Admin (implemented, not in v1.0) | **Resolved (1.2):** no separate role; centralized customer records belong to Compliance & Security | Keeps the role model to the seven PRD roles |
| D6 | Weekend working Oct 24–25 | Team decision; the plan in §8.2 assumes yes | Without it, launch scope shrinks further |

### 0.4 Changes in 1.2 **[New in 1.2]**

1. **Seven roles, one per persona.** Version 1.1 proposed ten system roles (Intake Officer, separate Compliance Officer, Security Admin and Auditor, Customer Records Admin). The business confirmed the PRD's seven roles are enough. Intake work moves to the Claim Operation Manager; user administration, audit and customer records move to Compliance & Security; four-eyes approval replaces the separate Security Admin (§2.3).
2. **Schema implemented as specified in §5.** Migration `20261022000007_prd_schema.sql` converts the earlier MVP schema in place (no data loss). §5.5 lists what was built and the deviations.
3. **Settlements merged into payments.** A settlement is a `payments` row in `PENDING_APPROVAL` with ordered `settlement_approval_steps`; there is no separate settlements table.

### 0.5 Changes in 1.3 **[New in 1.3]**

1. **Claims Operations Manager.** After a customer raises a claim it is assigned directly to a Claims Operations Manager (`CLAIMS_OPS_MANAGER`), not to a manager queue. This role handles the initial processing: intake, coverage verification, the intake checklist, collecting and verifying the payee's bank details, document routing and adjuster assignment.
2. **Claims Manager.** The former Claim Operation Manager role (`OPS_MANAGER`) is renamed Claims Manager and keeps the decisions: reserve reviews above adjuster authority, settlement approval above adjuster authority (from 1.4), denials, document exceptions, evaluation returns, closure and reopening.
3. **Automatic routing.** On submission the claim is given to the active Claims Operations Manager with the fewest open claims (then fewest open tasks). A claim raised on a client's behalf stays with the Claims Operations Manager who raised it. If nobody holds the role, the intake task waits in the role queue and Claims Managers are notified.
4. **Payee details at intake.** A claim cannot leave intake until the payee's bank details are recorded and verified by someone other than the person who entered them.

### 0.6 Changes in 1.4 **[New in 1.4]**

1. **Adjuster approves settlements within authority.** The claim's assigned adjuster approves the settlement when the amount is within the adjuster's settlement limit, which equals their reserve limit (15,000 personal, 30,000 commercial). Larger settlements go to a Claims Manager. This replaces the Payment Operator approval tier of 1.1–1.3 (migration `20261027000012_adjuster_settlement_authority.sql`).
2. **Payment Operator issues only.** Payment Operators no longer approve settlements. They verify payees, record bank-detail changes, issue and reconcile payments. The approver of a settlement still cannot issue it.
3. **Preparer rule.** The settlement is prepared on behalf of the adjuster, so the preparer-cannot-approve rule applies to Claims Manager steps only. An adjuster step can be decided only by the claim's currently assigned adjuster; the database enforces this too (`enforce_settlement_step`).

### 0.7 Changes in 1.5 **[New in 1.5]**

Portal enhancements (migration `20261027000014_ui_enhancements.sql`).

1. **Indian rupees.** Every amount is shown as ₹ with Indian digit grouping (₹1,25,000.00), in the UI, notifications and ledger notes. The stored currency code is `INR`; existing rows changed code only, amounts were not converted.
2. **Indian mobile numbers.** Phone fields (FNOL contact, registration, profile, staff accounts) take a 10-digit mobile number starting 6–9 after a fixed +91, and store it as `+91 98450 10101`. Other formats are refused by the API.
3. **Loss location.** FNOL step 2 captures the address or place in a larger field plus separate city and country (`claims.loss_city`, `loss_country`); all three are required to submit.
4. **No future loss dates.** The loss date and time cannot be in the future, checked in the form, on every draft save and at submission. Date pickers block dates that cannot apply: past-only filters (claims queue, audit log, reports) stop at today; due dates and deadlines cannot be in the past.
5. **Insured name from the policy.** Customers cannot edit the insured name; the API always takes it from the policy. Staff filing on a customer's behalf may correct it.
6. **Required documents before continuing.** FNOL step 4 cannot be left until every required document is uploaded (a rejected upload does not count). The checklist shows Missing, Uploaded or Accepted with an icon and words.
7. **Policy renewal requests.** Customers request a renewal (6, 12 or 24 months) from My Policies. A Claims Operations Manager or Claims Manager completes it, extending the policy from its current expiry (or today, if expired), or declines it with a reason the customer sees. Cancelled policies cannot be renewed (`policy_renewal_requests`; Policy Renewals page).
8. **My Claims filters.** Customers filter their claims by status, claim type and submission period. Search boxes were removed from the header, My Claims, the claims queue and the payment queue; admin lookup screens (Users & Roles, Audit log, Customer Records) keep theirs.
9. **Rejection notifications.** Rejections have their own templates (`CLAIM_REJECTED`, `DOCUMENT_REJECTED`, `APPROVAL_REJECTED`) and are shown with a red marker, an icon and a "Rejected" label, so they do not rely on colour alone.
10. **Masked settlement amounts.** Customers see approved and paid settlement amounts as ₹ ••••• until they choose to show them. Staff access to settlement amounts is unchanged (role-restricted on the server).
11. **Timestamps.** The claim timeline and claim lists show date and time ("27 Oct 2026, 5:36 pm") in one format; relative times are shown alongside.
12. **Claims Manager dashboard.** The settlement tile counts only settlements waiting for a Claims Manager, not those within adjuster authority.

---

## 1. Executive Summary & Scope

The Enterprise Claims Operations Hub gives claims staff one screen for claim status, missing artifacts, task ownership, reverse-review checkpoints and payment status. Today staff hop between the policy admin, document management, adjuster assignment and payment portals. Delivery target is October 27, 2026.

| Item | Detail |
|---|---|
| Project | Enterprise Claims Operations Hub |
| Document status | DRAFT (v1.1) |
| Target delivery | October 27, 2026 |
| Core team | Mohammed Naveed, Siva S, Mohammed Thoufic, Isswarya Murugan, Keerthika, Madana Priyan, Durga |
| Frontend | React 19 Progressive Web App (PWA), built with Vite (§6.0) |
| Backend | Node.js 20 LTS+, Express 5 modular monolith (§6.0) |
| Database | PostgreSQL 15+ (§6.0, decision D1) |
| Infrastructure | AWS, Docker (§6.0, §7.5) |
| AI layer | Claude (`claude-opus-5-5`) as agents at workflow decision nodes, advisory only (§6.4) |

### 1.1 Problem statement

Claim data and open activities are spread across legacy systems that do not share state. Staff re-key data, chase missing documents by email, and cannot see who owns the next action or whether a reserve or payment is blocked. The result is slow cycle times, hidden bottlenecks and weak auditability.

### 1.2 Primary objective and success metric

**Objective:** deliver a unified hub that tracks claim status, missing workflow artifacts, task ownership, reverse-review checkpoints and payment workflow status across all source systems.

**Core success metric:** claim information and outstanding activities from fragmented legacy systems appear in a single operational interface, and every open item shows an owner and a due state.

Supporting KPIs (targets to be confirmed with the business before baseline measurement; **baseline to be measured in the two weeks before go-live from the current systems**):

| KPI | Definition | Target (proposed) |
|---|---|---|
| Systems consulted per claim | Distinct applications a user opens to progress one claim | 1 (the Hub) |
| Missing-artifact turnaround | Time from flag to client upload | −40% vs. baseline |
| Reserve escalation latency | Time from escalation to manager decision | < 1 business day |
| Payment-block resolution time | Time from block to release | −30% vs. baseline |
| Stage SLA attainment **[New in 1.1]** | Share of stage clocks (§3.10) stopped before `due_at` | ≥ 90% at 60 days after launch |
| End-to-end cycle time **[New in 1.1]** | FNOL to first payment, excluding paused customer-wait time | Personal: ≤ 15 business days median |
| AI suggestion acceptance | Share of Claude recommendations accepted by humans | Tracked; no target at launch |

### 1.3 In scope

- All nine lifecycle stages: FNOL through Closure & Recovery.
- Integration with policy admin, document management, adjuster assignment, payment portal and legacy claims systems.
- Seven personas, each with one system role (§2.1), with RBAC/ABAC, a full audit trail and fraud-score governance.
- PWA for policyholders and field adjusters, including mobile upload and offline capture.
- Claude agents at defined decision nodes, with human approval on all financial and denial outcomes.
- Collection, protection and lifecycle management of customer personal data (§2A). **[New in 1.1]**

Full-lifecycle scope is intentional: the core problem is tracking across systems, and tracking is reliable only if the Hub owns workflow state, tasks and review checkpoints for all nine stages. What ships on October 27 versus later is set by §8.1 (decision D3).

### 1.4 Out of scope (this release)

- Replacing or migrating the legacy policy, claims or payment systems; the Hub integrates with them.
- Underwriting, billing and policy servicing functions.
- Fully autonomous payment or denial decisions without human sign-off.
- Native iOS/Android apps (the PWA covers mobile).
- Automated fraud determinations: fraud scores inform routing and review only (§3.3).

### 1.5 Assumptions and dependencies

- Read access to legacy policy and document systems is available by the integration milestone.
- A payment portal API or file-based interface exists for EFT and check issuance.
- Historical settlement data of sufficient quality exists to seed the reserve recommendation engine.
- Reserve authority limits per adjuster are defined by the business and stored as configuration.
- Legal supplies the regulatory claim-handling time limits for each jurisdiction in scope before design freeze; where they are shorter than §3.10, they override it. **[New in 1.1]**
- Security approves the Claude hosting platform and data-handling terms (decision D2) before any production claim data is sent to a model. **[New in 1.1]**

---

## 2. User Roles & Authorization Matrix (RBAC) **[Updated in 1.1]**

Access is role-based (RBAC) with attribute-based (ABAC) constraints for claim assignment, monetary authority, region, segment and data sensitivity. Compliance & Security owns policy definitions; **changes to those definitions need a second approver from outside the author's role (§2.3)**. No role can approve its own work.

### 2.1 Personas and system roles **[Updated in 1.2]**

The claims-operations persona is covered by two roles since 1.3: the Claims Operations Manager owns new claims, and the Claims Manager makes the decisions. Every other persona has exactly one system role. Role codes are defined in `shared/constants.js` and seeded in the `roles` table.

| Persona | System role code | Key responsibilities | Primary workflows |
|---|---|---|---|
| Claims Operations Manager **[New in 1.3]** | `CLAIMS_OPS_MANAGER` | Owns each new claim from submission: intake, coverage verification, intake checklist, collecting and verifying payee bank details, document routing, adjuster assignment, holds and escalation | Operations dashboard (claims assigned to them), claims queue, unassigned claims, tasks, reminders, AI extraction review |
| Claims Manager **[Renamed in 1.3]** | `OPS_MANAGER` | Reserve reviews above adjuster authority; settlement approval above adjuster authority; denials; document exceptions; evaluation returns; closure and reopening; configuration approvals; team oversight | Team workload, reserve reviews, settlement approvals, decision history, compliance queue, configuration, reports, audit |
| Adjuster | `ADJUSTER` | Loss evaluation, liability and loss value, reserve set and revise within authority, settlement approval on own claims within authority (1.4), recoveries, closure requests | Assigned-claim worklist, evaluation, reserve ledger, settlement approvals, closure & recovery |
| Document Review Team | `DOCUMENT_REVIEWER` | Document completeness and acceptance, missing-artifact and information requests, AI extraction review | Review queue, artifact requests, reminders |
| Payment Operator | `PAYMENT_OPERATOR` | Payee verification, bank-detail changes, payment issuance and reconciliation (settlement approval moved to the adjuster in 1.4) | Payment queue, payment blocks, reconciliation |
| Data Engineer | `DATA_ENGINEER` | Integration pipelines and sync health, cross-system claim matching, source-precedence rules | Integrations monitor, pipeline audit, read-only claims and configuration |
| Compliance & Security | `COMPLIANCE_SECURITY` | Compliance reviews, holds and exceptions; fraud governance; user, role and authority administration; full audit access; centralized customer records | Compliance queue, audit log and hash-chain verification, users & roles, customer records, configuration approvals |
| Client / Policyholder | `CLIENT` | Submit FNOL, upload artifacts, answer requests, track status and payment | FNOL wizard, document upload, requests, status tracker, notifications |
| AI agent service | service identity (`actor_type = AGENT`), not a user role | Runs Claude agents | No interactive access; least-privilege scopes (§2.3) |

A person may hold several roles and switch workspace in the header. Roles are granted by Compliance & Security, and nobody can change their own roles, limits or status.

### 2.2 Authorization matrix **[Updated in 1.3]**

Key: **C** create, **R** read, **U** update, **A** approve, **X** execute/issue, **-** no access, **own** only records assigned to or created by the user, **ltd** limited fields or amounts per ABAC rule. Columns: COM = Claims Operations Manager, Mgr = Claims Manager, Adj = Adjuster, Doc = Document Review, Pay = Payment Operator, DE = Data Engineer, C&S = Compliance & Security, Client. The executable form of this matrix is `shared/permissions.js`.

| Resource / action | COM | Mgr | Adj | Doc | Pay | DE | C&S | Client |
|---|---|---|---|---|---|---|---|---|
| Claim record | C, R, U (owner) | R, U | R, U (own) | R (review stages) | R (settlement stages onward) | R (ltd) | R | C, R (own) |
| Coverage verification | C, U | R | R | R | - | - | R | - |
| Policy data and snapshots | R | R | R | R | R (ltd) | R | R | R (own, ltd) |
| Customer contact PII | R | R | R (own claims) | R | - (payee only) | - | R | R, U (own) |
| Centralized customer records and export | - | - | - | - | - | - | R, X (audited) | R (own data, §2A.5) |
| Documents / artifacts | C, R | C, R | C, R (own) | C, R, U (review) | - | - | R | C, R (own) |
| Artifact and information requests | C, R, U | C, R, U | C | C, R, U | - | - | R | R, respond (own) |
| Tasks | C, R, U, reassign | C, R, U, reassign | C, R, U (own) | C, R, U (own) | C, R, U (own) | C, R, U | C, R, U | - |
| Evaluation | - | R, return | C, U (own) | - | - | - | R | - |
| Reserves | - | A, modify (above adjuster authority) | C, U (within authority) | - | R | - | R | - |
| Fraud score | R (band only) | R (score) | R (band only) | - | - | - | R (score), C, U (flags) | - |
| Claim assignment / routing | C, U (assigned automatically) | C, U | R (own) | - | - | - | R | - |
| Settlement approval **[Changed in 1.4]** | - | A (above adjuster authority; not the preparer) | A (own claim, within authority) | - | R | - | R | - |
| Policy renewal **[New in 1.5]** | A (complete or decline) | A (complete or decline) | - | - | - | - | R | C (request, own policy) |
| Payee verification and bank-detail changes | C, U at intake; A (not own change) | R | - | - | C, U, A (not own change) | - | R | C (own, step-up auth) |
| Payment issuance and reconciliation | - | R | - | - | X (not if approver) | - | R | R (own status) |
| Compliance review and holds | Operational hold and resume | R | - | - | - | - | C, U, A | - |
| Closure | - | A (closes and reopens) | Request (own) | - | - | - | R | R (own status) |
| Subrogation and salvage | - | C, U | C, U (own) | - | R | - | R | - |
| Notifications | R (own) | R (own) | R (own) | R (own) | R (own) | R (own) | R (own) | R (own) |
| Segment config and authority limits | R | Propose, A (2nd approver) | - | - | R | R | Propose, A (2nd approver) | - |
| Audit logs | - | R (claims in scope) | - | - | - | R (pipeline) | R (all), verify chain | - |
| Users, roles and authority overrides | - | - | - | - | - | - | C, U (never own) | - |
| Integration config (sync runs, xref, precedence) | - | - | - | - | - | C, U | R | - |
| AI agent runs (`ai_runs`) | R, accept/reject | R, accept/reject | - | R, accept/reject | - | - | R | - |

### 2.3 Access control rules

- **Separation of duties:** the user who prepares a reserve, settlement or payment cannot approve or issue it, and **the user who approves a settlement cannot issue its payment**. **[Updated]**
- **Monetary authority (ABAC):** reserve and settlement limits are attributes on the user profile (`authority_limits`, by role, segment and coverage line). Amounts above the limit route to the next approver, and the approver's limit at decision time is stored on the approval row.
- **Assignment scoping:** adjusters see only claims assigned to them or their team; clients see only their own claims. Out-of-scope claims return `404`, so their existence is never disclosed.
- **Conflict of interest:** staff cannot act as staff on a claim where they are the claimant. **[New]**
- **Sensitive data:** payee bank details and fraud scores with reason codes are masked unless the role is authorized. Claims Manager and Compliance & Security see the full score; adjusters see only the risk band; other roles see neither. Every unmasking is logged.
- **Four-eyes on governance changes:** `segment_config` (including the fraud review threshold) and `authority_limits` changes need a proposer and a different approver (`SELF_APPROVAL_FORBIDDEN`; `authority_limits` has a CHECK that creator ≠ approver). Role grants are made by Compliance & Security, can never target the granting user, and are audited. **[Updated in 1.2]**
- **AI actions:** Claude agents run under an agent service identity (audit rows carry `actor_type = AGENT`) with least-privilege scopes: read the minimized claim facts and documents of the claim being processed, and write only `ai_runs` rows. Agents never hold approval rights, never call approval, payment or transition endpoints, and are offered no tools that change state. **[Updated]**
- **Sessions:** see §7.2 for SSO, MFA, step-up and timeout values.
- **Closure:** adjusters submit a closure request; only the Claims Manager can close or reopen a claim.
- **Intake routing:** every submitted claim is assigned automatically to one active Claims Operations Manager (lowest workload); the assignment is audited as a system action and the owner is notified. Claims Managers can reassign with a reason. **[New in 1.3]**
- **Payee before routing:** a claim cannot leave intake until its payee's bank details are recorded and verified; the person who entered the details cannot verify them. **[New in 1.3]**
- **Defense in depth:** every rule above is enforced in the API policy layer and again in PostgreSQL (row-level security, CHECK constraints and triggers), so a bypassed API still cannot break them. **[New]**

### 2.4 Access reviews and joiner–mover–leaver **[New in 1.1]**

- Joiner: staff accounts are created by Compliance & Security and receive no role until one is granted explicitly. Self-registration grants only `CLIENT` and requires acceptance of the current privacy notice.
- Mover: a role change removes the previous role's grants on the same day; open tasks are reassigned by a Claims Manager.
- Leaver: the account is deactivated within 4 business hours of HR notice, and sessions are revoked immediately.
- Quarterly access review by Compliance & Security: every grant re-certified by the user's manager; unused grants (no login in 90 days) are removed.

---

## 2A. Customer Data Collection & Privacy **[New in 1.1]**

### 2A.1 Principles

- **Purpose limitation:** personal data is collected only to register a customer, assess and settle a claim, pay the claimant, meet legal retention duties, and detect fraud. Collected data is not used for marketing.
- **Minimization:** each FNOL field below is either required for the claim type or optional and marked as such. The PWA does not ask for anything else.
- **Transparency:** a privacy notice (versioned) is shown before registration and before FNOL submission. It names the data collected, the purposes, AI-assisted processing (§2A.3), retention, and how to exercise rights.
- **Accuracy:** customers can view and correct their own profile and contact data; claim facts are corrected through staff with an audit trail.

### 2A.2 Data inventory

Classification levels are defined in §7.2.1 (Public, Internal, Confidential, Restricted).

| Data element | Collected at | Source | Purpose | Required? | Class | Visible to | Protection | Retention |
|---|---|---|---|---|---|---|---|---|
| Full name, email | Registration | Customer | Identity, communication | Yes | Confidential | Customer, claim-scoped staff, Compliance & Security | Unique email; TLS; encrypted at rest | 7 years after last activity (§2A.6) |
| Phone number | Registration / FNOL step 5 | Customer | Contact, SMS/push notices | Yes for FNOL | Confidential | As above | As above; Indian mobile format, stored as `+91 XXXXX XXXXX` (1.5) | As above |
| Postal address **(not yet collected)** | FNOL step 5 | Customer / policy snapshot | Correspondence, check payments, jurisdiction | Yes for check payments | Confidential | Claim-scoped staff | As above | As above |
| Policy number and policy snapshot | FNOL step 1 | Policy admin | Coverage verification | Yes | Confidential | Claim-scoped staff, customer (own, ltd) | Immutable snapshot with SHA-256 | Life of claim + retention |
| Incident date/time, location (address, city, country), category, description | FNOL step 2 | Customer | Loss assessment | Yes (description ≥ 20 chars) | Confidential | Claim-scoped staff, customer (own) | Validated (not in future, on every save) | Life of claim + retention |
| Estimated loss, affected asset | FNOL step 3 | Customer | Priority, reserve | Yes | Confidential | Claim-scoped staff | `numeric(14,2)` | As above |
| Photos, documents, scans | FNOL step 4 and later | Customer, adjuster | Evidence | Per claim-type checklist | Confidential; **Restricted** for medical | Per document category; internal evidence never shown to customers | Private storage; SHA-256; versioned; virus-scanned (§7.2) | As above |
| GPS and capture time on photos | PWA capture | Device | Evidence integrity | Only with location permission | Confidential | Claim-scoped staff | Hash at capture (CAM-3) | As above |
| Medical information (health claims) | FNOL / documents | Customer, providers | Health claim assessment | Health claims only | **Restricted** | Assigned adjuster, doc reviewer, compliance | Field-level encryption; never sent to AI without minimization | As required by health-record rules (Legal) |
| Third parties and witnesses (`claim_parties`) | FNOL / investigation | Customer, adjuster | Liability, subrogation | Optional | Confidential | Claim-scoped staff | `contact_encrypted` | As above |
| Recorded statements (audio, transcript) | Field inspection | Claimant, witnesses | Evidence | Optional, consent required | Confidential | Assigned adjuster, compliance | Consent stored with recording | As above |
| Bank account and payee details | Settlement | Customer | Payment | Yes for EFT | **Restricted** | Payment Operators (unmask audited); masked for all others | Field-level encryption; never cached offline; change controls §7.2.5 | Payment record retention (Legal) |
| National identifier / tax ID **(only if a payment rail or regulation requires it)** | Payee verification | Customer | Sanctions and tax checks | Conditional | **Restricted** | Payment Operators, Compliance | Field-level encryption | As above |
| Declaration, consents and notice versions | Registration, FNOL step 6 | Customer | Proof of consent | Yes | Internal | Compliance & Security | Immutable; timestamped | As long as the related data |
| Device, IP, session metadata | Every request | System | Security, audit | Automatic | Internal | Compliance & Security | Hash-chained audit | 7 years (audit) / 90 days (app logs) |

### 2A.3 Consent and notices

| Item | When | Mechanism | Stored as |
|---|---|---|---|
| Privacy notice | Registration and FNOL submission | Must be viewed; version recorded | `consents` row: `subject_id, notice_version, accepted_at, channel` |
| Claim declaration (truthfulness) | FNOL step 6 | Mandatory checkbox; submission blocked without it (implemented) | `claims.declaration_accepted`, `declaration_accepted_at` |
| Communication channels (email, SMS, push) | Registration; editable in profile | Opt-in per channel; claim-critical notices always go to at least one channel | `notification_preferences` |
| Location on photos | First PWA camera use | OS permission plus in-app explanation; photos work without it | Per-upload flag |
| Audio statement recording | Before each recording | Spoken and on-screen consent captured in the recording | Recording metadata |
| AI-assisted processing | Privacy notice | Notice (not a consent gate): documents may be read by an AI model to pre-fill fields that staff then check; no automated decisions | Notice version |

Withdrawal of an optional consent stops that processing from the time of withdrawal. Withdrawal of the claim declaration is handled as a claim withdrawal.

### 2A.4 Identity verification

- **Customer registration:** email verification is required before first sign-in. Phone verification by one-time code is required before the first FNOL submission.
- **Policy linkage:** a customer can file only against a policy whose holder matches the verified identity. Where the policy admin record does not match, the claim routes to intake for manual verification (implemented: ownership is checked on submission).
- **Payee verification:** name match against the bank account holder, sanctions screening, and the bank-detail change controls in §7.2.5.

### 2A.5 Data-subject rights

| Right | How | Target response time (Legal to confirm per jurisdiction) |
|---|---|---|
| Access / copy | Self-service export of own profile, claims, letters and documents from the PWA | 30 days |
| Correction | Self-service for profile and contact data; claim facts through a staff-handled request (audited) | 30 days |
| Erasure | Request to the grievance officer. Granted only when no retention duty, open claim or legal hold applies; otherwise refused with the reason | 30 days |
| Withdraw consent | Profile settings (optional consents) | Immediate |
| Grievance | Named grievance officer contact on every customer page | Acknowledge in 2 business days |

### 2A.6 Retention and deletion

- Customer and claim records are kept for 7 years after the last activity, or longer where regulation requires (implemented as `CUSTOMER_RECORD_RETENTION_YEARS`, default 7). Records cannot be deleted through the application.
- Legal hold suspends deletion for named customers or claims.
- After retention expires, a scheduled job anonymizes personal fields and deletes stored files. Audit rows keep the actor and entity IDs but drop personal values.
- PWA offline caches are cleared on logout, on device-wipe signal, or after 14 days of inactivity (configurable).

---

## 3. Detailed Functional Requirements

The Hub orchestrates nine stages and three decision nodes. Each stage below lists inputs, outputs, UI components and the Claude agent's trigger and prompt contract. Claude proposes and explains; humans approve every reserve escalation outcome, denial and payment.

**Lifecycle at a glance:** FNOL → Coverage Verification → Triage & Assignment → Investigation & Document Intake → Reserve Management → Evaluation & Decision → Settlement & Authorization → Payment Issuance → Closure & Recovery.

No decision node ends in an automatic outcome: reserve escalations, denials and payment blocks all land with a named human owner.

### 3.0 Cross-cutting requirements

- **FR-X1 Unified claim view:** one claim page aggregates status, timeline, open tasks with owner and due date, missing artifacts, reserve history, review checkpoints and payment status from all source systems.
- **FR-X2 Task engine:** every outstanding activity is a task with owner, role, due date, state and linked artifact; workflow transitions create tasks automatically. A task may start with a team queue as its owner, but it needs a named person once work begins. Unclaimed queue tasks escalate to the Claims Manager after a configurable wait (default: 50% of the stage SLA). Tasks pulled from legacy systems follow the same rule.
- **FR-X3 Reverse-review checkpoints:** at defined gates (reserve change, denial, settlement, closure) a second reviewer re-checks the prior stage's output before the claim advances.
- **FR-X4 Agent contract [Updated]:** every Claude call returns structured JSON validated against a versioned JSON Schema:
  `{ recommendation, confidence, rationale, evidence_refs[], needs_human, fields? }`
  - `confidence` is a number from 0 to 1 (per field where the agent extracts fields). The UI shows bands: High ≥ 0.80, Medium 0.50–0.79, Low < 0.50.
  - `evidence_refs` items are `{ document_id, page, quote }` or `{ entity_type, entity_id }`.
  - `needs_human` is always `true` for financial, denial, coverage-negative and fraud-related outputs.
  - Every call is stored in `ai_runs` with `agent`, `prompt_version`, `model`, `input_hash` (SHA-256 of the minimized input), output, confidence, latency, token counts, and the human decision that followed.
- **FR-X5 Notifications:** in-app, email and push for task assignment, missing artifacts, escalations and status changes. Customer notices never reveal internal statuses: holds and compliance stages show as "Under review".
- **FR-X6 Segment-driven configuration:** every claim carries a segment (personal or commercial). The segment selects required artifacts, reserve and settlement authority limits, approval tiers, severity thresholds, SLA targets (§3.10) and routing rules from `segment_config` and `authority_limits`. These change through versioned, four-eyes-approved configuration (§2.3), not a code release.
- **FR-X7 Legacy task ingestion:** open to-dos in the legacy systems are pulled into the Hub task list (linked in `task_sources`), shown with owner and due date like Hub-created tasks, and re-synced until the source item closes. Completing one in the Hub writes back where the source system allows it.
- **FR-X8 Workflow integrity [New]:** permitted status transitions, the roles allowed to make each, and their guards are defined once (`shared/workflow.js`). The API state machine and a database trigger both enforce them. Invalid transitions return `422 INVALID_TRANSITION` with the permitted next statuses; failed guards return `409 WORKFLOW_GUARD_FAILED` listing each failed condition.
- **FR-X9 Idempotency [New]:** FNOL submission and every money-moving POST accept an `Idempotency-Key`. A replay returns the original result; reusing the key for a different resource is rejected.

### 3.1 First Notice of Loss (FNOL)

| Aspect | Requirement |
|---|---|
| Inputs | Policy number or identity lookup, loss date/time/location, loss description, parties, uploaded photos/forms/emails |
| Outputs | Claim record with ID (`HPC-<year>-<sequence>`), linked policy snapshot, extracted loss facts, initial task set |
| UI components | Guided six-step FNOL form (web and PWA) with server-side drafts, policy lookup, upload tray, intake review screen for staff, duplicate-claim warning |
| Functional rules | Ingest policy data from policy admin on creation and store an immutable snapshot. Detect probable duplicates by policy, incident category and an incident time within 24 hours; the customer must confirm a separate incident, and the claim is flagged for intake. On submission the claim is assigned to the Claims Operations Manager with the lowest workload, who receives the intake task **[1.3]**. Acknowledge the client automatically within 5 minutes of submission (§3.10) |
| AI feature | Automated intake parsing and data extraction from uploads |
| Agent trigger | On FNOL submission and on each new upload during intake |
| Agent prompt contract | System: "You are a claims intake analyst. Extract loss date, location, loss type, parties, damages and injuries from the submitted text and documents. Return JSON with a confidence per field. Never infer values that are not present; use null." Fields below 0.80 confidence are flagged for staff confirmation. **No extracted value is written to the claim until a staff member selects and confirms it** |

### 3.2 Coverage Verification

| Aspect | Requirement |
|---|---|
| Inputs | Policy snapshot (status, effective and expiry dates, coverages, limits, deductibles, exclusions), extracted loss type and date |
| Outputs | Coverage result (covered, not covered, needs review), matched perils, applicable limits and deductible, reasoning note |
| UI components | Coverage panel with active/inactive badge, peril-match table, policy clause viewer, override with reason |
| Functional rules | Reject automatically only on hard facts (policy inactive on loss date). All other negative outcomes route to human review. Reservation-of-rights letter template available |
| AI feature | Automated policy contract check against the claimed loss type |
| Agent trigger | After FNOL data is confirmed |
| Agent prompt contract | System: "Compare the claimed loss to the policy wording provided. Identify the covering clause, any exclusion that may apply, limits and deductible. Quote clause references by ID. If wording is ambiguous, set needs_human true." |

### 3.3 Triage & Assignment

| Aspect | Requirement |
|---|---|
| Inputs | Loss facts, coverage result, claimant and policy history, geography, adjuster capacity and skills |
| Outputs | Severity class, complexity tier, fraud score with reason codes, assigned adjuster, SLA clock |
| UI components | Triage queue, severity and complexity chips, fraud score card with reason codes, assignment suggestion with accept/reassign, workload heatmap |
| Functional rules | Fraud scores above a configurable threshold route to a special investigation queue and require Compliance-visible review; the score never denies a claim on its own |
| AI feature | Predictive fraud detection scoring and intelligent adjuster routing |
| Agent trigger | On coverage confirmation and when material new facts arrive |
| Agent prompt contract | System: "Classify severity (low, medium, high, catastrophic) and complexity (1 to 4). Score fraud risk 0 to 100 and list reason codes from the approved taxonomy. Recommend the best-fit adjuster from the candidate list with a one-line reason." Reason codes are mandatory and logged for compliance. **Input excludes protected attributes and their proxies (name, gender, age, religion, postcode below district level)** |

### 3.4 Investigation & Document Intake

| Aspect | Requirement |
|---|---|
| Inputs | Statements, inspection reports, photos, police or repair reports, estimates, client uploads |
| Outputs | Classified and indexed documents, completeness status, outstanding-artifact list, automated client requests |
| UI components | Checklist of required artifacts per loss type, upload and camera capture (PWA), OCR result viewer with field correction, request-status tracker, adjuster inspection form |
| Functional rules | Required-artifact templates are configurable by loss type, segment and jurisdiction. Reminders escalate on a schedule. Every upload is content-type sniffed, virus-scanned and versioned. Reviewers cannot review documents they uploaded |
| AI feature | OCR and a document completeness engine that auto-flags missing artifacts and prepares missing-document requests to the client |
| Agent trigger | On every document upload and nightly for all open claims (nightly run uses the Message Batches API, §6.4) |
| Agent prompt contract | System: "Classify each document, extract key fields, and compare the claim's artifact checklist against what is present. Return missing items, illegible or expired items, and a client-friendly request message in plain language." Requests go by email, SMS and PWA push. **Customer-facing requests are drafts until a staff member approves them** (implemented); staff may edit before sending |

### 3.5 Reserve Management

| Aspect | Requirement |
|---|---|
| Inputs | Evaluation notes, damage estimates, coverage limits, historical settlements for similar claims |
| Outputs | Initial or revised reserve with rationale, authority check result, escalation task if required |
| UI components | Reserve worksheet by coverage line, AI recommendation panel with comparable claims, authority indicator, reserve history timeline, manager review screen |
| Decision node | Is the reserve within adjuster authority? **Yes:** reserve is posted. **No:** escalate to Manager Reserve Review (approve, modify or reject with comment) |
| AI feature | Reserve recommendation engine based on historical claim settlement data (advisory only at launch) |
| Agent trigger | On first evaluation data, on material change, and on manager request |
| Agent prompt contract | System: "Using the claim facts and the comparable settled claims provided, recommend a reserve range and point estimate per coverage line. Explain the top drivers and list the comparables used." The adjuster may accept or override; overrides require a reason code |

### 3.6 Evaluation & Decision

| Aspect | Requirement |
|---|---|
| Inputs | Investigation file, coverage result, liability facts, repair or medical estimates |
| Outputs | Liability assessment, calculated loss value, payment decision, denial letter if applicable |
| UI components | Evaluation worksheet, liability percentage input, deductible and depreciation calculator, decision panel, letter preview |
| Decision node | Approve payment? **Yes:** proceed to Settlement. **No:** the written denial reasons engine drafts the letter, then manager review (reverse-review checkpoint) happens before it is issued |
| AI feature | Drafts the denial reasons, citing policy clauses and file evidence, and summarizes liability evidence |
| Agent trigger | When the adjuster marks evaluation complete or selects Deny |
| Agent prompt contract | System: "Draft a denial letter in plain, regulator-compliant language. Cite the specific policy provisions and facts relied on. Do not introduce reasons not in the file. Flag any missing required notice language." Humans edit and approve; templates are jurisdiction-specific |

### 3.7 Settlement & Authorization **[Updated in 1.1]**

| Aspect | Requirement |
|---|---|
| Inputs | Approved loss value, payee details, liens, deductible, release terms |
| Outputs | Release document, verified payee, approval chain record, payment instruction |
| UI components | Settlement builder, release generator, payee verification panel, multi-level approval tracker, payment-block resolution queue |
| Decision node | Approved and payee verified? **Yes:** proceed to Payment. **No:** Resolve payment block workflow (task to the right owner, with reason and due date) |
| Functional rules | Approval levels depend on amount, segment and claim type. Verification includes name match, sanctions screening and the bank-detail change checks in §7.2.5. The preparer cannot approve; the approver cannot issue. A settlement cannot exceed the approved reserve. Settlement approval is blocked while a compliance hold is active |
| AI feature | Flags payee anomalies (new bank details, name mismatch, duplicate payee) and drafts the block-resolution request; humans decide |
| Agent trigger | When the settlement is submitted and when payee data changes |
| Agent prompt contract **[New]** | System: "You review a settlement's payee record for anomalies before payment. Compare the payee name with the insured and claimant names, the bank details with prior payments to this payee, and the payee with other open settlements. Return each anomaly with a code from the approved list (NEW_BANK_DETAILS, RECENT_BANK_CHANGE, NAME_MISMATCH, DUPLICATE_PAYEE, PAYEE_ON_MULTIPLE_CLAIMS, THIRD_PARTY_PAYEE), the evidence, and a draft request to the payee or owner in plain language. Never conclude that fraud occurred and never recommend releasing or blocking the payment; set needs_human true whenever any anomaly is present." Input: masked account numbers (last 4 digits plus a keyed hash for equality), never full bank details |

### 3.8 Payment Issuance

| Aspect | Requirement |
|---|---|
| Inputs | Approved payment instruction, verified payee, payment method |
| Outputs | Check or EFT executed, confirmation reference, reserve reduction entry, payment status updates |
| UI components | Payment queue, status tracker (queued, sent, cleared, failed, voided), reissue and stop-payment actions |
| Functional rules | Idempotent calls to the payment portal (`Idempotency-Key` required). Processing happens in three phases: lock and mark processing; call the portal outside the transaction; record the outcome. A database compare-and-set ensures at most one concurrent attempt. Reserve reduces only on confirmed issuance. Failures create a payment-block task. A reconciliation job compares Hub and portal status daily. Payment is refused while a compliance hold is active |
| AI feature | None for execution; optional summary of failed-payment causes for the operator |

### 3.9 Closure & Recovery **[Updated in 1.1]**

| Aspect | Requirement |
|---|---|
| Inputs | Final payments, outstanding reserves, third-party liability facts, salvage items |
| Outputs | Subrogation decision and referral, salvage tracking, closure record, reopen history |
| UI components | Closure checklist, subrogation assessment card, salvage tracker, reopen with reason |
| Functional rules | Adjusters submit a closure request and only the Claims Manager can close. Closure requires zero open mandatory tasks, no pending approvals, no active compliance hold and zero outstanding reserve (or an approved exception). Rejected and withdrawn claims close with open work cancelled. Reopening restores the task history and requires a reason and approval |
| AI feature | Subrogation potential assessment (liable third party, recovery likelihood, deadline) with evidence references |
| Agent trigger | When all payments clear or when a manager requests closure review |
| Agent prompt contract **[New]** | System: "Assess subrogation and salvage potential from the claim file. Identify any third party whose act or product may have caused the loss, the evidence for it, the applicable limitation deadline if stated in the provided jurisdiction table, and salvageable property. Return recovery_likelihood as low, medium or high with a rationale, the evidence references, and the date by which a referral must be made. Do not estimate recovery amounts beyond the paid amounts in the file. Set needs_human true." |

### 3.10 End-to-end claim timeline and SLA clocks **[New in 1.1]**

Each stage starts an `sla_clocks` row when the claim enters it and stops the row when the claim leaves it. Targets are per segment from `segment_config`. **Regulatory maximums supplied by Legal override these targets wherever they are shorter.** Personal-segment targets match the values implemented in `shared/workflow.js` (`STATUS_SLA_HOURS`).

| # | Stage (system statuses) | Clock starts | Clock stops | Target: personal | Target: commercial | Paused while | Owner | On breach |
|---|---|---|---|---|---|---|---|---|
| 0 | Acknowledgement | FNOL submitted | Automated acknowledgement sent | 5 minutes | 5 minutes | — | System | Alert to on-call engineer |
| 1 | FNOL intake (`SUBMITTED`) | Submission | Policy verification starts | 24 h | 24 h | — | Claims Operations Manager, assigned automatically at submission | Level 1 escalation to Claims Managers |
| 2 | Coverage verification (`POLICY_VERIFICATION`) | Verification starts | Coverage recorded, checklist complete, payee verified | 48 h | 3 business days | Waiting on policy admin data | Claims Operations Manager | Level 1 |
| 3a | Documents required (`DOCUMENTS_REQUIRED`) | Request sent | All requested items received | 14 days (customer) | 21 days (customer) | **Insurer clock paused** | Customer; doc reviewer chases | Reminders at 50% and 90%; then Claims Manager review |
| 3b | Document review (`DOCUMENT_REVIEW`) | Item uploaded | All required items accepted or exception recorded | 48 h | 48 h | — | Doc review queue → named reviewer | Level 1 |
| 4 | Triage & assignment (`ADJUSTER_ASSIGNMENT`) | Documents complete | Adjuster assigned | 24 h | 24 h | — | Claims Operations Manager | Level 1, then level 2 at 2× target |
| 5 | Investigation and evaluation (`INVESTIGATION`) | Adjuster assigned | Assessment submitted | 10 days | 20 days | Waiting on third-party reports (reason required) | Assigned adjuster | Level 1 at target, level 2 at 1.5× |
| 6 | Reserve review (`RESERVE_APPROVAL`) | Reserve escalated | Manager decision | 1 business day | 2 business days | — | Claims Manager with sufficient authority | Level 2 to next authority tier |
| 7 | Compliance review (`COMPLIANCE_REVIEW`) | Review opened | Cleared, exception or hold | 72 h | 5 business days | Active hold (reason required) | Compliance & Security | Level 2 |
| 8 | Settlement approval (`SETTLEMENT_APPROVAL`) | Settlement submitted | All approval steps decided | 48 h | 3 business days | Payee verification pending on customer | Approver chain | Level 2 |
| 9 | Payment issuance (`PAYMENT_PENDING`, `PAYMENT_FAILED`) | Settlement approved | Portal confirms issuance | 48 h (failed: 24 h to retry) | 48 h | Portal outage (incident ID required) | Payment operator | Level 2; block task |
| 10 | Closure (`PAID` → `CLOSED`) | Payment cleared | Claim closed | 5 business days | 10 business days | Open recovery deadline | Claims Manager | Level 1 |

**End-to-end targets (excluding paused time):** personal segment ≤ 15 business days from FNOL to payment for claims without investigation pauses; commercial ≤ 30 business days. The SLA dashboard shows the clock for every open claim with time remaining and time paused.

**Escalation ladder:** level 1 notifies the stage owner and their manager; level 2 adds the Claims Manager and puts the claim on the bottleneck board; level 3 (manual) adds the head of claims. Overdue checks run every 15 minutes (implemented) and notify once per due date.

**Customer-facing timeline:** the PWA tracker shows plain-language steps (Submitted → Under review → Documents needed → Being assessed → Approved → Paid → Closed), the expected date of the next step from the current clock, and what the customer must do, if anything.

---

## 4. PWA & Field Mobile Requirements

The React PWA serves policyholders filing and tracking claims and adjusters working on site, with or without connectivity. Field work must never be lost because of a dropped signal.

### 4.1 PWA foundation

- **PWA-1** Installable on iOS, Android and desktop via web manifest, icons and a service worker (`vite-plugin-pwa` / Workbox, §6.0); HTTPS only.
- **PWA-2** App shell cached for instant load; route-level code splitting keeps the first load under 250 KB gzipped. (Current build: the main chunk is 139 KB gzipped; routes are already lazy-loaded.)
- **PWA-3** Responsive layouts from 360 px wide; touch targets at least 44 px; WCAG 2.1 AA accessibility.
- **PWA-4** Web push for task assignments, missing-artifact requests and status changes, with in-app and email fallback where push is unsupported (notably older iOS).
- **PWA-5 [New]** The service worker caches only static assets and data marked cacheable for offline work (§4.2). It never caches API responses containing Restricted data (§7.2.1), and authentication tokens are kept in memory or `sessionStorage`, never in the service-worker cache.

### 4.2 Offline and online sync

| Capability | Requirement |
|---|---|
| Offline reads | Assigned claims, checklists, policy snapshots and recent documents cached in IndexedDB for the user's active worklist |
| Offline writes | Inspection notes, photos, statements and task updates queued locally with a client-generated UUID and timestamp |
| Sync | Background Sync replays the queue when online; falls back to sync-on-open where Background Sync is unavailable; uploads are chunked and resumable; each replayed write carries its UUID as the idempotency key |
| Conflict handling | Append-only data (photos, notes) merges automatically; field edits to shared records use version numbers, and a conflict screen shows both versions for the user to choose |
| Status visibility | Persistent banner showing online/offline, queue size and last sync time; per-item states: pending, uploading, synced, failed |
| Data safety | Local cache encrypted (Web Crypto, AES-GCM, key derived per session) where the platform allows; cache cleared on logout, device wipe signal or after a configurable inactivity period (default 14 days); no payment bank details or Restricted fields cached offline |
| Limits | Per-device cache budget (default 200 MB) with oldest-closed-claim eviction |

### 4.3 Camera and document capture

- **CAM-1** In-app capture using the device camera, with multi-page document scanning, auto edge detection, and perspective correction.
- **CAM-2** On-device image compression (target under 2 MB per image, original retained on request for evidence photos).
- **CAM-3** Photo metadata (time, GPS where permitted) recorded and tamper-evident via hash at capture.
- **CAM-4** Upload from gallery or files for PDFs; supported types: JPEG, PNG, WebP, HEIC (converted), PDF; maximum 10 MB per file (current server limit).
- **CAM-5** Immediate quality checks (blur, glare, cropped edges) with a retake prompt before upload.
- **CAM-6** After upload, OCR runs server-side; the user sees extracted fields and the updated checklist ("3 of 5 documents received").

### 4.4 Field inspection UI (adjuster)

- **Today's visits:** list and map of assigned inspections with address, contact and navigation hand-off.
- **Inspection form:** configurable by loss type; structured fields, damage checklist, room or area sections, severity ratings.
- **Evidence:** photos and video attached to specific form items; annotation (arrows, text) on photos.
- **Statements:** audio recording with consent capture and a speech-to-text draft that the adjuster must review; signature capture.
- **Quick reserve and estimate:** read-only AI recommendation and a draft estimate; reserve submission needs connectivity to run the authority check.
- **Finish and sync:** completion summary, missing items prompt, and queue status.

### 4.5 Policyholder experience

- **Claim tracker:** plain-language status steps with the expected next-step date (§3.10), what is needed from the client, and a contact.
- **Request inbox:** each missing-artifact request with example images and a one-tap capture action.
- **Privacy:** the client sees only issued letters and client-safe notes, never fraud scores, internal statuses or internal comments. The privacy notice, consents and the data-export action live in the profile (§2A).
- **Languages:** English at launch; strings externalized from day one for additional languages.

---

## 5. Database Schema Guidelines (PostgreSQL)

The Hub owns its operational schema and mirrors legacy data through integration pipelines. Legacy systems remain the system of record for policy and payment execution; the Hub is the system of record for workflow, tasks, reviews and audit.

### 5.1 Conventions

- UUID primary keys (`gen_random_uuid()`); human-readable claim numbers from a sequence.
- `created_at`, `updated_at`, `created_by`, `updated_by` on every table; `version` integer for optimistic locking.
- Money as `numeric(14,2)` with a `currency` column; never floats.
- Enumerated states as Postgres enums, lookup tables or `text` with CHECK constraints; soft delete only (`deleted_at`) for business records.
- Foreign keys enforced; indexes on every FK and on common filters (status, assignee, due date).
- Row-level security on claims and child tables for ABAC scoping; PII columns encrypted (pgcrypto or KMS-managed application-level encryption, §7.2.3).
- Partition `audit_logs` and `ai_runs` by month; retain per §7.4.
- **[New]** Status transitions, approval authority, payment state changes and immutability are enforced by triggers so that rules hold even if the API is bypassed. Trigger errors use `CODE: message` so the API can map them to `409` responses.

### 5.2 Key tables

| Table | Purpose | Key columns |
|---|---|---|
| `claims` | Master claim record and workflow state | id, claim_number, policy_id, status, stage, loss_date, loss_type, loss_location, severity, complexity, fraud_score, assigned_adjuster_id, coverage_result, opened_at, closed_at, reopen_count, segment |
| `policies` | Current synced policy, versioned; each claim uses a frozen copy in policy_snapshots | id, external_policy_no, status, effective_date, expiry_date, insured_id, coverages (jsonb), limits, deductibles, exclusions, source_synced_at |
| `documents` | Artifact metadata and OCR output | id, claim_id, doc_type, storage_key (S3), version, uploaded_by, source (pwa, email, dms), ocr_text_ref, extracted_fields (jsonb), status, sha256, received_at |
| `artifact_requirements` | Required artifacts per claim and their state | id, claim_id, doc_type, status (missing, requested, received, rejected), requested_at, due_at, document_id |
| `reserves` | Reserve history by coverage line | id, claim_id, coverage_line, amount, currency, prev_amount, reason_code, set_by, ai_run_ref (no FK), authority_ok, approval_status, approved_by, effective_at |
| `payments` | Settlement and payment lifecycle | id, claim_id, payee_id, amount, currency, method (check, eft), status, approval_chain, portal_reference, idempotency_key, issued_at, cleared_at, block_reason |
| `payees` | Payee master and verification | id, name, type, verification_status, bank_details_encrypted, bank_details_hash, bank_details_changed_at, sanctions_checked_at |
| `tasks` | Ownership of outstanding work | id, claim_id, type, owner_user_id, owner_role, due_at, status, source_stage, blocking, is_mandatory |
| `reviews` | Reverse-review checkpoints | id, claim_id, checkpoint_type, subject_ref, reviewer_id, outcome, comments, reviewed_at |
| `evaluations` | Liability and loss value | id, claim_id, liability_pct, loss_value, decision, denial_letter_doc_id |
| `recoveries` | Subrogation and salvage | id, claim_id, type, target_party, expected_amount, recovered_amount, status, deadline |
| `ai_runs` | Every Claude invocation | id, claim_id, agent, prompt_version, model, input_hash, output (jsonb), confidence, needs_human, human_decision, decided_by, latency_ms, input_tokens, output_tokens, status, error_code |
| `users`, `roles`, `user_attributes` | Identity, RBAC and ABAC attributes | role, reserve_limit, settlement_limit, region, team_id, mfa_enrolled_at |
| `consents` **[New]** | Notice versions and consents per subject | id, subject_id, consent_type, notice_version, granted, channel, recorded_at, withdrawn_at |
| `data_subject_requests` **[New]** | Access, correction and erasure requests | id, subject_id, request_type, status, received_at, due_at, decided_by, outcome, legal_hold_ref |
| `governance_changes` **[New]** | Four-eyes record for role, policy and configuration changes | id, change_type, target_ref, proposed_by, proposed_at, approved_by, approved_at, before (jsonb), after (jsonb); CHECK proposed_by ≠ approved_by |
| `integration_sync_runs` | Pipeline health and reconciliation | source_system, started_at, records_in, records_failed, status, checkpoint |
| `audit_logs` | Immutable event trail | id, occurred_at, actor_id, actor_type (user, agent, system), action, entity_type, entity_id, before (jsonb), after (jsonb), ip, request_id, hash_prev, hash |
| `policy_snapshots` | Frozen copy of the policy at FNOL; coverage checks read this, never the live policy | id, claim_id, policy_id, policy_version, snapshot (jsonb), captured_at, sha256 |
| `segment_config` | Per-segment settings so behavior changes by configuration, not code | segment (personal, commercial), config_key, config_value (jsonb), version, effective_from, effective_to, approved_by; covers required artifacts, severity thresholds, SLA targets, routing rules, approval tiers |
| `authority_limits` | Reserve and settlement limits by role, segment and coverage line | id, role, segment, coverage_line, limit_type (reserve, settlement), max_amount, currency, effective_from, effective_to |
| `coverage_results` | Outcome of each coverage check | id, claim_id, snapshot_id, result, matched_perils (jsonb), applied_limits, deductible, clause_refs, ai_run_ref, reviewed_by, created_at |
| `claim_parties` | Claimants, insureds, witnesses and third parties | id, claim_id, party_type, name, contact_encrypted, role_in_loss, represented_by, is_payee_candidate |
| `fraud_reason_codes` | Approved taxonomy for fraud scoring; claim-level hits stored in claim_fraud_flags | code, description, category, weight, active, version; claim_fraud_flags: claim_id, code, contribution, ai_run_ref |
| `sla_clocks` | SLA timers by claim and obligation | id, claim_id, clock_type (acknowledge, stage, decide, pay), stage, segment, started_at, due_at, paused_at, paused_total, pause_reason, stopped_at, breached_at, escalation_level |
| `settlement_approval_steps` | Ordered approval steps for each settlement | id, payment_id, step_no, required_role, approver_id, authority_limit_id, approver_limit_at_decision, status, decided_at, comment |
| `payment_blocks` | Why a payment is held and how it was resolved | id, payment_id, block_type, detail, opened_at, owner_task_id, resolved_by, resolved_at, resolution |
| `notifications` | In-app, email, SMS and push messages | id, recipient_type, recipient_id, claim_id, channel, template, status, sent_at, read_at |
| `document_versions` | Version history for each document | id, document_id, version_no, storage_key, sha256, uploaded_by, uploaded_at, change_reason |
| `claim_xref` | Maps one Hub claim to its identifiers in each source system | id, claim_id, source_system, external_claim_id, match_method (exact, rule, manual), match_confidence, status, last_synced_at |
| `source_precedence` | Which system wins per field group when sources disagree | field_group, source_system, rank, rule (source_wins, hub_wins, latest_wins, manual_review), updated_by |
| `task_sources` | Links Hub tasks to open to-dos pulled from legacy systems | task_id, source_system, external_ref, external_status, first_seen_at, last_seen_at, sync_state |
| `closure_requests` | Adjuster requests to close a claim, decided by the Claims Manager | id, claim_id, requested_by, reason, status, decided_by, decided_at |

### 5.3 Relationships

- `policies` 1 to many `claims`; `claims` 1 to many each of `documents`, `artifact_requirements`, `reserves`, `payments`, `tasks`, `reviews`, `recoveries`, `sla_clocks`.
- `payments` many to 1 `payees`. `reserves` may reference an `ai_runs` row by ID with no foreign key, because `ai_runs` is partitioned by month.
- `audit_logs` references any entity by type and id (polymorphic) with no foreign key, so it survives archival.

### 5.4 Audit and integrity rules

- `audit_logs` is append-only: revoke UPDATE and DELETE from application roles, block them with a trigger, and chain rows by `hash_prev` for tamper evidence (`hash = sha256(hash_prev || canonical_json(row))`, computed in the inserting transaction under an advisory lock).
- Writes to business tables and the matching audit row occur in one transaction (or via a transactional outbox).
- Reserve and payment balances are derived from ledger-style rows; never overwrite a prior amount.
- Policy versions: `policies` keeps a new version row whenever the source changes, and each claim keeps a frozen copy in `policy_snapshots` taken at FNOL. Coverage checks and evaluations read the snapshot; a new snapshot is created only through an approved re-verification.

**Reserves DDL [Corrected in 1.1]**: adds the §5.1 columns, a currency, and a CHECK that a reserve outside authority cannot be posted without an approver.

```sql
CREATE TABLE reserves (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        uuid NOT NULL REFERENCES claims(id),
  coverage_line   text NOT NULL,
  amount          numeric(14,2) NOT NULL CHECK (amount >= 0),
  prev_amount     numeric(14,2),
  currency        char(3) NOT NULL DEFAULT 'INR',
  reason_code     text NOT NULL,
  set_by          uuid NOT NULL REFERENCES users(id),
  ai_run_ref      uuid,               -- no FK: ai_runs is partitioned by month
  authority_ok    boolean NOT NULL,
  approval_status text NOT NULL
                  CHECK (approval_status IN ('posted', 'pending_review', 'approved', 'modified', 'rejected')),
  approved_by     uuid REFERENCES users(id),
  effective_at    timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id),
  deleted_at      timestamptz,
  -- within authority: posted directly; outside authority: must go through review
  CONSTRAINT reserves_authority_rule CHECK (
    (authority_ok AND approval_status = 'posted')
    OR (NOT authority_ok AND approval_status IN ('pending_review', 'rejected'))
    OR (NOT authority_ok AND approval_status IN ('approved', 'modified') AND approved_by IS NOT NULL)
  ),
  CONSTRAINT reserves_no_self_approval CHECK (approved_by IS NULL OR approved_by <> set_by)
);
CREATE INDEX reserves_claim_idx ON reserves (claim_id, effective_at DESC);
CREATE INDEX reserves_pending_idx ON reserves (approval_status) WHERE approval_status = 'pending_review';
```

The default currency is a placeholder until the jurisdictions in scope are confirmed (open question 2).

### 5.5 Schema as implemented **[New in 1.2]**

Migration `database/migrations/20261022000007_prd_schema.sql` implements §5.1–§5.4 and converts existing data in place. Migration `20261022000008_workflow_transitions.sql` loads the role-based transition table generated from `shared/workflow.js`.

| Area | As built |
|---|---|
| Identity and roles | `profiles` renamed `users`; `roles` holds the seven codes; old role grants are mapped to the new codes. `user_attributes` holds per-user `reserve_limit` / `settlement_limit` overrides, region and team. `authority_limits` holds role defaults by segment and limit type; `effective_limit(user, type, segment)` resolves override then role default |
| Configuration | `segment_config` (PERSONAL, COMMERCIAL) with versioned keys `required_artifacts`, `sla_hours`, `severity_thresholds`, `fraud_review_threshold`, `unclaimed_task_escalation_hours`; status PROPOSED → ACTIVE/REJECTED → RETIRED |
| Policies and claims | `policies` uses `external_policy_no`, `insured_id`, `effective_date`, `expiry_date`, `segment`, `coverages`, `limits`, `payee_id`. `claims` uses `loss_date`, `loss_location`, `loss_type`, `loss_description`, `opened_at` and adds `stage` (derived by trigger), `segment`, `severity`, `fraud_score`, `reopen_count`, `policy_snapshot_id`, `version`. Claimant contact moved to `claim_parties.contact_encrypted` |
| Coverage | `policy_snapshots` frozen at submission; `coverage_results` (COVERED, NOT_COVERED, NEEDS_REVIEW) with clause references |
| Documents | `documents` (`doc_type`, `storage_key`, `version`, `sha256`, `received_at`, `extracted_fields`) plus `document_versions`; `artifact_requirements` holds required documents and ad-hoc document/information requests (MISSING → REQUESTED → RECEIVED → ACCEPTED/REJECTED, WAIVED, CLOSED, CANCELLED) |
| Tasks | `tasks` with `type`, `owner_user_id`, `owner_role`, `blocking`; `task_sources` for legacy to-dos; unclaimed queue tasks escalate |
| Evaluation and reviews | `evaluations` (`loss_value`, `liability_pct`, `decision`, `denial_letter_doc_id`); `reviews` for COMPLIANCE, RESERVE, EVALUATION and CLOSURE checkpoints, immutable once decided |
| Reserves | Ledger per §5.4: every change is a new row (`reason_code` includes MANAGER_MODIFIED, PAYMENT_ISSUED, CLOSURE_RELEASE); within authority → POSTED, otherwise PENDING_REVIEW; a trigger blocks edits to posted amounts |
| Settlements and payments | `payments` covers PENDING_APPROVAL → PENDING → PROCESSING → PAID/FAILED → RECONCILED; `settlement_approval_steps` routes to PAYMENT_OPERATOR within authority, else OPS_MANAGER; `payment_blocks` (PAYMENT_FAILED, COMPLIANCE_HOLD, PAYEE_UNVERIFIED, BANK_DETAILS_CHANGED); `payees` with AES-256-GCM `bank_details_encrypted`, HMAC `bank_details_hash` and verification. Triggers enforce approver ≠ issuer and changer ≠ verifier |
| Fraud | `fraud_reason_codes` (weighted taxonomy) and `claim_fraud_flags`; a trigger recomputes `claims.fraud_score` (capped at 100) |
| SLA | `sla_clocks` (ACKNOWLEDGE, STAGE) with pause, `paused_seconds`, breach and escalation level |
| Closure and recovery | `closure_requests` (requester ≠ decider), `recoveries` (SUBROGATION, SALVAGE) |
| Integration | `integration_sync_runs`, `claim_xref`, `source_precedence` |
| Privacy | `consents` (PRIVACY_NOTICE at registration, CLAIM_DECLARATION at submission, channel consents) |
| AI | `ai_runs` partitioned by month: `agent`, `prompt_version`, `model`, `input_hash`, numeric `confidence`, `needs_human`, `human_decision` |
| Notifications | One row per channel (IN_APP with `read_at`; EMAIL with delivery status) |
| Audit | `audit_logs` partitioned by month and hash-chained (`seq`, `hash_prev`, `hash`) under an advisory lock; `verify_audit_chain()` reports breaks |
| Row-level security | Rebuilt for the seven roles on every table; partitions are not directly accessible. Migration `20261026000010` adds the Claims Operations Manager to the claim scope and the policy, payee, AI-run and reminder policies |

Not built in this schema: `data_subject_requests` and a general `governance_changes` table (four-eyes is enforced on `segment_config` and `authority_limits` directly), and `policies` version rows (a new snapshot per claim is taken instead).

---

## 6. Architecture, Technology Stack & APIs **[Updated in 1.1]**

### 6.0 Technology stack **[New in 1.1]**

"Current" is what this repository runs today; "Target" is the enterprise configuration. Rows where they differ are migration items (Appendix A).

| Layer | Current (repository) | Target | Notes |
|---|---|---|---|
| Language | JavaScript (ES modules), Node.js ≥ 20.19 | Same; TypeScript adoption for new modules is optional, not a launch item | Converting 250 files in five days adds risk without user value |
| Web framework | Express 5, Zod validation, Helmet, CORS, express-rate-limit, Multer | Same | Modular monolith, one module per domain |
| Frontend | React 19, Vite 8, React Router 7, Tailwind CSS 4, Radix UI (shadcn-style), React Hook Form + Zod, Recharts, Framer Motion | Same, plus `vite-plugin-pwa` (Workbox), IndexedDB (`idb`) for the offline queue | Business rules shared with the server via `shared/` |
| Database | PostgreSQL 14+ via a `pg` pool; built-in migration runner; tests on per-file clones of a template database | Amazon RDS for PostgreSQL 16 (Multi-AZ) or another managed PostgreSQL (decision D1) | SQL migrations are plain Postgres and portable |
| Auth | The API's own email + password sign-in on `auth.users` (scrypt; bcrypt accepted for imported accounts), HS256 session tokens | OIDC SSO with MFA for staff (corporate IdP or Amazon Cognito); email/phone OTP for customers | `authProvider` adapter isolates the change |
| File storage | PostgreSQL `document_files` (write-once, SHA-256 checked, streamed through the API) | Same, or Amazon S3 with SSE-KMS and Object Lock if volumes grow | `storage` adapter isolates the change |
| GraphQL | Not implemented (REST only) | Apollo Server 4 or GraphQL Yoga for the read-heavy claim view, with depth and cost limits | REST remains the command API |
| Async work | In-process timers (15-minute sweeps) | Amazon SQS queues + worker containers for OCR, AI calls, notifications and sync; EventBridge Scheduler for sweeps | Required before running more than one API instance |
| OCR | Claude reads PDFs and images directly (document extraction) | Same for structured extraction; Amazon Textract only if a volume or cost test shows a need | Avoids two extraction pipelines |
| AI | `@anthropic-ai/sdk`, model `claude-opus-5-5` | Same SDK; platform per decision D2 (§6.4) | |
| Email / SMS / push | Console adapter (logs only) | Amazon SES, Amazon SNS (SMS), Web Push (VAPID) | Adapter contract `send()` already exists |
| Payments | Simulated adapter (`SIM-` references) | Payment portal adapter implementing `initiateTransfer()` | Keep idempotency and the three-phase flow |
| Containers | None | Docker images (Node 20 Alpine, non-root, distroless where possible); ECS Fargate or EKS (open question 6) | |
| IaC / CI | None | Terraform or AWS CDK; GitHub Actions running lint, tests, build, image scan and SBOM | |
| Observability | JSON request logs with request ID | CloudWatch + OpenTelemetry traces, metrics and alarms (§7.5) | |
| Testing | Vitest + Supertest (151 server tests incl. RLS and an end-to-end lifecycle test), Testing Library (22 client tests) | Add Playwright end-to-end, k6 load tests, contract tests per adapter | |

### 6.1 Design principles

- **REST for commands and integrations:** versioned under `/api/v1`, JSON, resource-oriented, idempotency keys on all POSTs that move money or state.
- **GraphQL for the Hub view:** one query returns claim, tasks, artifacts, reserves, reviews and payments, resolving from Postgres and, where needed, cached legacy sources; query depth and cost limits enforced.
- **Auth:** OIDC/SSO (JWT access tokens) for staff, verified sessions for clients. RBAC and ABAC checks live in a policy layer (`shared/permissions.js`, `access.service.js`), not in route handlers.
- **Async work:** SQS-backed queues and workers for OCR, Claude calls, notifications and sync jobs; webhooks and events carry a request ID for tracing.
- **Errors:** the current envelope is `{ error: { code, message, details, requestId } }`. Target: RFC 7807 problem details (`type`, `title`, `status`, `detail`, `instance`) with `code` and `requestId` as extensions, so existing clients keep working. Consistent pagination (`limit`, `cursor`), filtering and sorting.

### 6.2 REST endpoints

Implemented endpoints are documented with examples in [API.md](API.md); this table is the target contract. Where a current path differs, it is shown in brackets.

| Area | Method and path | Purpose | Roles |
|---|---|---|---|
| Claims | POST /claims, POST /claims/{id}/submit | Create FNOL draft; submit (idempotent) | Client, Intake, Adjuster |
| Claims | GET /claims/{id} | Claim summary | By ABAC scope |
| Claims | PUT /claims/{id} [PATCH] | Update editable fields only; stage and status change only via /transitions | Adjuster, Intake, Ops |
| Claims | POST /claims/{id}/transitions | Move workflow stage (validated by state machine) | Role per transition |
| Coverage | POST /claims/{id}/coverage-check [/verify-policy] | Run AI and rule coverage check | System, Intake, Adjuster |
| Triage | POST /claims/{id}/triage | Run severity, fraud and routing | System |
| Triage | PUT /claims/{id}/assignment [POST /assignments] | Assign or reassign adjuster | Ops, Intake |
| Documents | POST /claims/{id}/documents/upload-url | Get pre-signed S3 upload URL | Client, Adjuster, Doc Review |
| Documents | POST /claims/{id}/documents | Register uploaded file, trigger OCR | Client, Adjuster, Doc Review |
| Documents | GET /claims/{id}/artifact-requirements [/automation/document-checklist] | Checklist and gaps | By scope |
| Documents | POST /claims/{id}/artifact-requests [/information-requests] | Send missing-artifact request | Doc Review, System |
| Reserves | POST /claims/{id}/reserves [via /assessments/{id}/submit] | Set or revise reserve (runs authority check) | Adjuster |
| Reserves | POST /reserves/{id}/review [/decision] | Manager approve, modify or reject | Claims Manager |
| Evaluation | PUT /claims/{id}/evaluation [/assessments] | Save liability and loss value | Adjuster |
| Evaluation | POST /claims/{id}/decision | Approve or deny; denial drafts reasons | Adjuster, Ops |
| Settlement | POST /claims/{id}/settlements | Create settlement and release | Adjuster |
| Settlement | POST /settlements/{id}/approvals [/decision] | Record approval step | Assigned adjuster (within authority), Claims Manager |
| Payees | POST /payees/{id}/verify | Run payee verification | Payment Operator |
| Payments | POST /payments/{id}/issue [/process] | Issue check or EFT (idempotent) | Payment Operator |
| Payments | POST /payments/{id}/resolve-block [/retry] | Resolve payment block | Payment Operator |
| Closure | POST /claims/{id}/subrogation-assessment | AI and manual recovery assessment | Adjuster |
| Closure | POST /claims/{id}/close, POST /claims/{id}/reopen [/transitions] | Close or reopen with reason | Claims Manager only |
| Closure | POST /claims/{id}/closure-requests | Adjuster requests closure; Claims Manager decides | Adjuster |
| Tasks | GET /tasks?owner=me [view=mine], PATCH /tasks/{id} | Worklist and updates | All staff |
| Reviews | POST /reviews/{id}/outcome | Reverse-review result | Reviewer |
| Customers **[New]** | GET /customers, GET /customers/{id}, GET /customers/export | Centralized records (audited) | Compliance & Security |
| Privacy **[New]** | GET /me/data-export, POST /me/data-requests, PUT /me/consents | Data-subject rights and consents | Client |
| Governance **[New]** | POST /governance-changes, POST /governance-changes/{id}/approve | Four-eyes configuration and role changes | Proposer / approver per §2.3 |
| Audit | GET /audit-logs | Search audit trail; verify the hash chain | Compliance & Security (all), Claims Manager and Data Engineer (scoped) |
| Integration | GET /integrations/runs, POST /integrations/{source}/replay | Pipeline health and replay | Data Engineer |
| Webhooks | POST /webhooks/payments, /webhooks/dms, /webhooks/policy | Inbound events from legacy systems (HMAC-signed, replay-protected) | System |

### 6.3 GraphQL schema (illustrative)

```graphql
type Claim {
  id: ID!
  claimNumber: String!
  stage: Stage!
  status: ClaimStatus!
  segment: Segment!
  policy: PolicySnapshot!
  assignedAdjuster: User
  fraudScore: FraudScore        # masked by role
  slaClocks: [SlaClock!]!
  tasks(status: TaskStatus): [Task!]!
  missingArtifacts: [ArtifactRequirement!]!
  reserves: [Reserve!]!
  reviews: [Review!]!
  payments: [Payment!]!
  aiRuns(agent: String): [AiRun!]!
  timeline(limit: Int, cursor: String): TimelinePage!
}

type Query {
  claim(id: ID!): Claim
  myWorklist(filter: WorklistFilter, page: PageInput): TaskPage!
  claimsBoard(filter: BoardFilter): [BoardColumn!]!
  bottlenecks(teamId: ID, since: DateTime): [BottleneckStat!]!
}

type Mutation {
  requestMissingArtifacts(claimId: ID!, docTypes: [String!]!): [ArtifactRequirement!]!
  acknowledgeAiRecommendation(runId: ID!, accepted: Boolean!, reason: String): AiRun!
}
```

### 6.4 Claude agent service **[Updated in 1.1]**

An internal `AgentService` wraps all Claude calls so that prompts, models and policies are controlled in one place. Today this is `server/src/services/ai.service.js` (provider) and `server/src/modules/automation/ai-automation.service.js` (agents).

**Endpoint (internal):** `POST /internal/agents/{agentName}/run` with `claimId`, `trigger` and input references; returns the structured result and the `ai_runs` ID. It runs on a worker, not in the request path; the UI shows progress and never blocks on an agent.

**Model and request settings.** All agents use `claude-opus-5-5`, with effort tuned per agent. Opus 5.5 always uses adaptive thinking; effort is the only depth control, and it defaults to `medium`, so every request sets it explicitly. A cheaper model for high-volume agents is a business decision. It is considered only after the evaluation set (§6.7) shows equal quality, and it changes only through model change control (§7.3).

| Agent | Stage | Effort | Input sent to the model | Output gate |
|---|---|---|---|---|
| `intake-parser` | §3.1 | high | Uploaded document (PDF/image) + claim type | Staff confirm each field before it is saved (implemented as document extraction) |
| `coverage-checker` | §3.2 | high | Policy snapshot wording + minimized loss facts | Negative or ambiguous → human review |
| `triage-scorer` | §3.3 | medium | Minimized facts, history counts, candidate adjusters (IDs, skills, load) | Claims Operations Manager accepts or reassigns |
| `document-completeness` | §3.4 | medium (nightly via Batches API) | Checklist + document classifications | Customer request is a draft until approved (implemented rule-based version) |
| `claim-summarizer` (implemented) | All | medium | Minimized facts without names, contacts, claim or policy numbers | Labeled advisory; decision language removed |
| `reserve-recommender` | §3.5 | high | Facts + comparable settled claims (anonymized) | Adjuster accepts/overrides with reason; authority check is rule-based |
| `denial-drafter` | §3.6 | high | Evaluation, cited clauses, evidence excerpts | Manager reverse review before issue |
| `payee-anomaly` | §3.7 | medium | Masked payee record + keyed hashes + prior-payment stats | Payment operator decides |
| `subrogation-assessor` | §3.9 | high | Facts, third-party details (minimized), jurisdiction deadline table | Adjuster/Claims Manager decide referral |

**Request contract (implemented pattern).** Each call uses:
- `output_config.format` with a JSON Schema (`additionalProperties: false`), plus re-validation with Zod on the server; output that fails validation is discarded (`AI_INVALID_OUTPUT`).
- `output_config.effort` set explicitly.
- `stop_reason` handling: `refusal` → `AI_REFUSED` and manual handling; `max_tokens` → `AI_INCOMPLETE`, retryable.
- Refusal fallback: the server-side `fallbacks: "default"` parameter with the `server-side-fallback-2026-07-01` beta, so a safety-declined request is retried on Anthropic's recommended fallback model.
- Timeouts of 90 s per request with 2 SDK retries for transient errors; the caller sees typed error codes (`AI_TIMEOUT`, `AI_RATE_LIMITED`, `AI_UNAVAILABLE`, …) with a `retryable` flag.
- No tools offered to the model, so a model response cannot change state.

**Hosting platform (decision D2).**

| Option | Notes |
|---|---|
| Claude API (Anthropic first-party) | All features, including the server-side refusal fallback. Data leaves AWS |
| Claude Platform on AWS | Anthropic-operated, with same-day API parity, including the server-side fallback. Security to confirm data-handling and billing terms |
| Amazon Bedrock | Runs inside the AWS account boundary. Model ID takes the `anthropic.` prefix (`anthropic.claude-opus-5-5`); use the `AnthropicBedrockMantle` client from `@anthropic-ai/bedrock-sdk`. The server-side `fallbacks` parameter is not available; use the SDK's client-side refusal-fallback middleware instead. Partner pricing applies |

Security chooses based on the data-handling terms (open question 5). The provider adapter means the switch is a configuration and client-construction change.

**Cost basis.** First-party list price for `claude-opus-5-5` is $4 per million input tokens and $20 per million output tokens; Bedrock pricing differs. Each `ai_runs` row records input and output tokens, so cost per agent and per claim is reported from the database from day one. Levers, in order: prompt caching for long, stable prefixes (policy wording in `coverage-checker`); the Message Batches API (50% price) for the nightly completeness run; lower effort where the evaluation set shows no quality loss.

**Controls:**
- Versioned prompts stored in the repository; `prompt_version` recorded on every run.
- JSON-schema validation of outputs.
- PII minimization before the call (implemented for summaries: no names, contact details, claim or policy numbers).
- Documents treated as untrusted data, never as instructions: system prompts say so explicitly, and output is schema-constrained.
- Timeouts with retry and a rule-based fallback where one exists (missing-document checks and reminders work without AI).
- Mandatory human acknowledgement before any financial or denial action takes effect.
- With AI disabled (`AI_PROVIDER=none`), the API returns setup instructions and never placeholder output.

### 6.5 Integration adapters

| Source system | Pattern | Frequency |
|---|---|---|
| Policy admin | Change data capture or API polling into policies; on-demand refresh at FNOL | Near real-time, plus nightly reconciliation |
| Document management | Webhook and API sync of document metadata; Hub stores authoritative new uploads | Event-driven |
| Adjuster assignment | Two-way API sync of assignments and capacity | Every 5 minutes |
| Payment portals | Command API or file drop; status webhooks and daily reconciliation | Event-driven, daily recon |
| Legacy claims system | Database sync or API read of existing claims, reserves and payment history into the Hub; one-time backfill, then incremental sync (retire or keep as source of record: to be decided) | Backfill, then every 5 minutes |

All adapters authenticate with per-system credentials from AWS Secrets Manager, verify inbound webhook signatures (HMAC, timestamp within 5 minutes, replay cache), and write an `integration_sync_runs` row per run.

### 6.6 Cross-system claim matching and conflict rules

The five sources are policy admin, document management, adjuster assignment, payment portals and the legacy claims system. The defaults below are proposals to confirm with each system owner.

- **Identity mapping:** `claim_xref` links one Hub claim to its identifier in every source. Matching tries an exact key first (claim reference, or policy number plus loss date), then configurable rules, then a manual match queue for the Data Engineer. Matches below a confidence threshold are never auto-linked.
- **Conflicts:** `source_precedence` sets the winner per field group. Proposed defaults: policy admin wins policy fields; payment portal wins payment status and cleared amounts; document management wins document metadata; the legacy claims system wins historical claim data until the cutover decision; the Hub wins workflow state, tasks, reviews and audit. A differing value in a field with no clear winner goes to manual review and is logged.
- **Freshness:** every `claim_xref` row carries `last_synced_at`; the claim page shows it per source, with a stale badge when it is older than that source's sync interval.
- **Failures:** failed syncs retry, then raise a task for the Data Engineer; no failed source blocks the claim view.

### 6.7 AI evaluation and release gates **[New in 1.1]**

| Agent | Evaluation set (minimum) | Release gate (launch, advisory mode) |
|---|---|---|
| intake-parser | 100 labeled documents across claim types, including 10 with injected instructions | Field accuracy ≥ 95% on high-confidence fields; 0 fields filled from injected instructions; 0 invented values (non-null where label is null) above 2% |
| coverage-checker | 60 claims with adjuster-decided coverage | Agreement ≥ 90%; every disagreement has `needs_human = true` |
| triage-scorer | 200 historical claims | Severity agreement ≥ 85%; fraud reason codes 100% from taxonomy; disparity check across regions within ±5 points |
| document-completeness | 100 claims | Missing-item precision ≥ 95%, recall ≥ 90% |
| claim-summarizer | 50 claims | 0 decision or fraud statements; factual errors ≤ 2% of sentences (human-graded) |
| reserve-recommender, denial-drafter, payee-anomaly, subrogation-assessor | 50 cases each | Advisory only; human acceptance rate tracked; not shown to users until the gate is agreed by Compliance |

The evaluation set is versioned with the prompts. Any change of model, prompt or effort reruns it, and a regression on any gate blocks the change.

---

## 7. Non-Functional Requirements

Targets below are proposed starting points to be validated with infrastructure sizing and the business before sign-off.

### 7.1 Performance and SLAs

| Area | Requirement (proposed) |
|---|---|
| Availability | 99.9% monthly for staff-facing Hub and client PWA, excluding planned maintenance |
| Unified claim view | p95 under 1.5 s server response; p95 under 3 s fully rendered on a mid-range mobile on 4G |
| API reads / writes | p95 under 300 ms / 600 ms excluding AI and legacy calls |
| Document upload and OCR | Upload confirmation under 5 s; OCR result visible within 60 s for a typical 5-page document |
| AI agent calls | p95 under 15 s for interactive agents (hard timeout 90 s); the UI never blocks on an agent (async with progress state) |
| Sync freshness | Policy and assignment data within 5 minutes of source change; payment status within 2 minutes of webhook |
| Capacity | 500 concurrent staff users and 5,000 concurrent client sessions at launch; horizontal scaling to 3× |
| Recovery | RPO 15 minutes, RTO 4 hours; automated encrypted backups with point-in-time recovery; quarterly restore test |

### 7.2 Security **[Expanded in 1.1]**

#### 7.2.1 Data classification

| Class | Examples | Rules |
|---|---|---|
| Public | Marketing pages, help text | No restriction |
| Internal | Workflow metadata, task titles, aggregate reports | Staff only |
| Confidential | Customer contact data, claim facts, documents, notes | Claim-scoped access; encrypted at rest; masked in logs |
| Restricted | Bank details, national/tax identifiers, medical data, fraud scores with reason codes, authentication secrets | Field-level encryption; unmasking audited; never in logs, AI prompts (except minimized/masked), offline caches or non-production environments |

#### 7.2.2 Identity and sessions

- **Staff:** OIDC SSO with phishing-resistant MFA (WebAuthn/passkeys preferred, TOTP accepted). Access tokens live 15 minutes, refresh tokens 8 hours. Idle timeout 30 minutes. Re-authentication within the last 5 minutes is required for approvals, payment issuance, unmasking and payee changes.
- **Customers:** verified email; phone OTP before first FNOL; step-up OTP for payment-related views and bank-detail changes. Idle timeout 30 minutes.
- **Brute force:** login and registration limited per IP and per account (implemented per IP: 30 attempts per 15 minutes in production), progressive delay, and lockout notification. Password reset tokens are single-use and expire in 30 minutes (implemented); responses never reveal whether an account exists (implemented).
- **Service identities:** workers and agents use IAM roles, not long-lived keys.

#### 7.2.3 Data protection and key management

- TLS 1.2+ in transit (HSTS, TLS 1.3 preferred); AES-256 at rest (RDS, S3 with KMS keys).
- Field-level envelope encryption (KMS data keys) for Restricted fields: `bank_details_encrypted`, national identifiers, medical fields, `contact_encrypted`. Equality lookups use a keyed HMAC column, never the plaintext.
- Separate KMS keys per environment and data class. Automatic annual rotation of KMS keys; secrets (DB, API keys, webhook secrets) in AWS Secrets Manager with rotation every 90 days, and immediately on staff departure or suspected exposure.
- Backups encrypted with a separate key; restore requires two people.

#### 7.2.4 Application and API security

- OWASP ASVS Level 2 controls; input validation on every endpoint (Zod, implemented); output encoding by React.
- Security headers via Helmet (implemented), plus a strict Content-Security-Policy for the PWA (no inline scripts; `connect-src` limited to the API and push service).
- CORS restricted to configured origins (implemented); no cookies for API auth (bearer tokens), so CSRF does not apply. If cookies are introduced, `SameSite=Strict` and CSRF tokens are required.
- Rate limits: authentication endpoints (implemented); general API per user (600 requests/minute), uploads (30/minute), AI endpoints (20/minute per user), exports (5/hour).
- Uploads: extension allow-list plus content sniffing (implemented), 10 MB limit (implemented), malware scanning before a file becomes downloadable (target: S3 event → scanner), files served only through authorized streaming or pre-signed URLs ≤ 5 minutes.
- CSV export guards against formula injection (implemented).
- Idempotency keys on money-moving and submission endpoints (implemented); webhook signature verification and replay protection.
- Dependency, container image and IaC scanning in CI; SBOM per release; annual penetration test plus one before go-live.

#### 7.2.5 Payment fraud controls **[New]**

- A bank-detail change by a customer needs step-up authentication and sends a notice to the previous contact channels.
- A changed payee bank account cannot receive a payment for 24 hours (configurable cooling-off) unless confirmed out-of-band (call-back to a number on file) by a Payment Operator other than the one issuing the payment.
- Every change of bank details by staff needs a reason (implemented) and a second Payment Operator's approval.
- Duplicate payee detection (same account on different payees, or same payee on several open claims) blocks issuance pending review.
- Sanctions screening at payee creation and before each payment.

#### 7.2.6 Network and infrastructure

- VPC with private subnets for database and workers; WAF and rate limiting at the edge; least-privilege IAM.
- No direct internet egress except through approved gateways (including the Claude API endpoint, if decision D2 selects it).
- Containers run as non-root with read-only file systems; images signed and scanned.
- Production access through SSO-backed bastion or SSM Session Manager only; every session logged.

#### 7.2.7 AI security

- Prompt-injection defenses: documents are treated as untrusted data, never as instructions (stated in every system prompt); output schema validation; no tools that change state; no agent access to approval endpoints.
- PII minimization before external calls, and Restricted data excluded or masked.
- AI keys only in server-side secrets, never in the frontend (implemented).
- Outputs that state a decision or fraud are withheld (implemented for summaries) and logged.

#### 7.2.8 Threat model summary

| Threat | Main controls |
|---|---|
| Account takeover of staff | SSO + MFA, short tokens, step-up for sensitive actions, anomaly alerts |
| Insider approving their own payout | Separation of duties in API and database, conflict-of-interest check, four-eyes on bank changes, audit |
| Bank-detail substitution fraud | §7.2.5 controls, payee-anomaly agent (advisory), notifications to prior channels |
| Broken object-level authorization (viewing other claims) | Central claim scope, 404 for out-of-scope, RLS second layer, integration tests per role (implemented) |
| Malicious upload | Content sniffing, size limit, malware scan, private storage, no inline execution |
| Prompt injection via documents | Untrusted-data prompting, schema output, no state-changing tools, human confirmation |
| Audit tampering | Append-only with triggers (implemented), hash chain, S3 Object Lock replica |
| Data exfiltration via export | Single role, rate limit, row cap (implemented 5,000), audit (implemented), DLP alert on unusual volume |
| Stolen field device | Encrypted offline cache, remote wipe signal, inactivity purge, no Restricted data offline |

### 7.3 Compliance and governance

- **Regulatory scope to confirm:** applicable insurance claims-handling regulations (timelines for acknowledgment, decision and written denial reasons), data protection law for the jurisdictions served (for example India's DPDP Act, GDPR where applicable), and record-retention rules. Legal and Compliance to confirm the list before design freeze.
- **Fraud scoring compliance:** documented model purpose, reason codes on every score, threshold change control with four-eyes approval (§2.3), bias and drift monitoring each quarter, and a rule that scores alone never determine denial.
- **Explainability:** every AI recommendation shows its rationale and evidence references; users can accept, edit or reject it, and their reasons are captured.
- **Data residency and retention:** claim and audit data stored in the approved AWS region; retention schedules per record type (§2A.6); legal hold support; deletion and anonymization workflows for data-subject requests where legally permitted.
- **Vendor and model governance:** Security and Legal review the AI provider's contract and data-handling terms. Model and prompt versions change only through change control, with regression tests on the evaluation set (§6.7).

### 7.4 Audit logging

- Log every create, update, approval, denial, unmasking of sensitive data, login, permission change, export and integration action, with actor, time, entity, before and after values (Restricted values redacted), IP and request ID.
- Log every Claude invocation: agent, prompt version, model, input hash, output, confidence, token counts and the human decision that followed.
- Audit records are append-only, hash-chained, replicated to write-once storage (S3 Object Lock), and searchable by Compliance & Security within 5 seconds for a 90-day window.
- Retention: 7 years by default, or longer where regulation requires (Legal to confirm).

### 7.5 Reliability, observability and operations

- Docker images deployed to AWS (ECS Fargate or EKS, to be decided); blue-green or rolling deploys with automated rollback; infrastructure as code (Terraform or CDK).
- Background sweeps (overdue tasks, reminders, SLA clocks) run as one scheduled job, not on every API instance.
- Centralized structured logging, metrics and tracing (CloudWatch with OpenTelemetry). Alerts on SLA breaches, sync lag, queue depth, OCR failure rate, agent error rate and AI refusal rate.
- Dashboards for pipeline health (Data Engineer), SLA and bottlenecks (Claims Manager), and agent quality and cost (acceptance rate, overrides, tokens per claim).
- Environments: dev, test, staging with masked production-like data, and production; no real PII outside production. Demo data (`SEED_DEMO_DATA`) is refused in production (implemented).

### 7.6 Quality and testing

- Unit and integration tests in CI; contract tests for each legacy adapter; end-to-end tests for the three decision nodes.
- Authorization tests for every role against every endpoint, plus database RLS tests (implemented for current roles).
- Agent evaluation set per agent with release gates (§6.7).
- Accessibility testing (WCAG 2.1 AA), device matrix for the PWA (recent iOS Safari, Android Chrome), and load tests before go-live.

### 7.7 Accessibility and usability

- Labelled controls, keyboard-operable tables, dialogs and menus, visible focus, reduced-motion support, charts with table alternatives (implemented in the current UI).

### 7.8 Incident response and breach notification **[New in 1.1]**

- **Severity levels:** Sev 1 (confirmed personal-data breach, payment fraud, or production outage); Sev 2 (suspected breach, degraded service); Sev 3 (contained issue).
- **Response:** an on-call engineer acknowledges a Sev 1 within 15 minutes; an incident commander is named within 30 minutes; affected credentials are rotated and sessions revoked as the first containment step.
- **Notification:** the DPO/Legal assesses notification duties within 24 hours of detection. Regulators and affected customers are notified within the statutory deadlines of each jurisdiction (Legal to confirm the exact windows, for example under India's DPDP Rules and GDPR).
- **Evidence:** audit logs and hash chain are preserved; affected records are put on legal hold.
- **Review:** a post-incident review within 5 business days, with actions tracked to closure.
- **Exercise:** one tabletop exercise before go-live, then twice a year.

---

## 8. Implementation Roadmap & Milestone Plan **[Updated in 1.1]**

October 27, 2026 is five calendar days from this revision (two are a weekend). The confirmed direction is the full nine-stage lifecycle. The v1.0 risk table already called for deferring the lowest-value features by agreement, launching AI recommendations as advisory only, and setting go/no-go criteria up front. This section makes those concrete (decision D3).

### 8.1 Phase scope, launch cut line and exit criteria

**Launch (Oct 27)** is what can pass UAT and security checks in five days, given that it is already built and tested (Appendix A). Later phases have proposed dates for team estimation.

| Phase | Launch, Oct 27 | Post-launch (proposed) | Exit criteria |
|---|---|---|---|
| 0. Foundation | Existing schema, RBAC + RLS, audit, unified claim workspace, task list with owners, FNOL wizard, notifications in-app. **Add:** Docker image, one AWS environment (staging + prod), production secrets, Claims-Manager-only closure rule, MFA for staff (via IdP), field-level encryption for bank fields, audit hash chain | SSO with corporate IdP; RDS/S3 migration (D1); GraphQL claim view; SQS workers — weeks of Nov 2 and Nov 9 | Staff sign in with MFA, create a claim, see policy, documents and open tasks on one screen; all actions audited; security baseline passed |
| 1. Core workflow | Existing intake, policy eligibility, document review, information requests, rule-based completeness, reminder drafts, AI document extraction and summaries (advisory), stage SLA clocks with escalation | Policy snapshots; coverage-checker and triage-scorer agents; fraud scoring; PWA install + offline queue + camera capture — Nov 9 to Nov 27 | Pilot team handles intake to investigation end to end; extraction meets the §6.7 gate |
| 2. Financial workflow | Existing assessments, reserve approval with limits, compliance review and holds, settlement approval, simulated payment with idempotency, reconciliation screen | Real payment portal adapter; per-coverage-line reserves; authority_limits by segment; payee verification and §7.2.5 controls; reserve, denial and payee agents — Nov 16 to Dec 11 | Separation of duties verified; ledgers reconcile with legacy systems; Compliance signs off financial controls. **Real money moves only after this exit** |
| 3. Closure and hardening | Closure guards, reopen, manager dashboards and reports, customer records | Closure requests, subrogation/salvage, legacy integrations and task ingestion, load/accessibility/penetration tests at full scope — Dec 2026 | UAT passed; NFR targets met in load test; runbooks and support model in place |

**Go/no-go criteria for Oct 27 (all must hold):**
1. All automated tests pass (currently 173) and the end-to-end lifecycle test passes against staging.
2. No open critical or high findings from the pre-launch security scan.
3. MFA enforced for all staff accounts; no default or demo credentials in production; demo data off.
4. Bank fields encrypted and audit hash chain live.
5. A pilot group completes the UAT script (SETUP.md §5) with no Sev 1/Sev 2 defects.
6. Payments stay on the simulated adapter, labeled as such, until Phase 2 exits.
7. Rollback tested once on staging.

### 8.2 Day-by-day plan to go-live (proposal)

| Day | Focus | Owner pod |
|---|---|---|
| Thu Oct 22 | PRD v1.1 review and sign-off; decisions D1–D6; pod staffing; freeze launch scope | Platform and product |
| Fri Oct 23 | Dockerfile, CI pipeline, AWS staging; MFA; bank-field encryption migration; closure-rule change; SLA clock escalation | Platform, Governance |
| Sat Oct 24 | Audit hash chain; consent and notice records; security scan and fixes; prepare AI evaluation set for extraction | Governance and AI, Data |
| Sun Oct 25 | Production environment; data load (policies, users); extraction evaluation run; documentation and runbooks | Platform, Data |
| Mon Oct 26 | UAT with pilot users; fix window; rollback rehearsal; go/no-go dry run | All pods |
| Tue Oct 27 | Go/no-go at 09:00; deploy; hypercare with daily triage for two weeks | All pods |

### 8.3 Embedded pods (forward-deployed model)

Delivery uses forward-deployed engineers: each pod embeds an engineer with the claims team it serves, ships fixes against real claims, and owns its phase's exit criteria. A phase exits only after its pod has run live claims and logged the fixes. Pod membership is a proposal for the seven-person core team to confirm at kickoff.

| Pod | Embedded with | Scope | Proposed engineer |
|---|---|---|---|
| Intake and documents | Document Review Team, policyholders | FNOL, OCR, completeness engine, PWA upload | To be assigned from core team |
| Field and reserves | Adjusters, Claims Manager | Field PWA, reserve engine and review, evaluation | To be assigned from core team |
| Payments and settlement | Payment Operators | Settlement, payee verification, issuance, reconciliation | To be assigned from core team |
| Data and integration | Data Engineer | Schema, legacy sync pipelines, reconciliation | To be assigned from core team |
| Governance and AI | Compliance & Security | RBAC/ABAC, audit, consent, fraud model governance, agent evaluation sets | To be assigned from core team |
| Platform and product | Claims Operations Manager, Claims Manager | Core API, workflow engine, unified view, infrastructure, backlog and UAT | To be assigned from core team |

### 8.4 Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| Delivery date is five days away for a nine-stage scope | Little room for integration, security, UAT and compliance sign-off | Launch cut line and go/no-go criteria (§8.1); AI advisory only; simulated payments until Phase 2 exits |
| Platform migration (Supabase → PostgreSQL) **[Updated]** | Data, credentials or documents lost in the move | Scripted, verified import (row counts, audit hash chain, files, password compatibility); Supabase kept as a backup until sign-off |
| Legacy system access or API gaps | Blocks sync and the unified view | Confirm access and interfaces first; use file or database-level sync as fallback |
| Poor historical data for reserve recommendations | Weak reserve suggestions | Recommendation is advisory only; measure before trusting |
| AI errors in extraction, coverage or fraud scoring | Wrong decisions or unfair outcomes | Human approval on financial and denial actions; confidence thresholds; evaluation gates (§6.7); audit of every run |
| Claude data-handling approval not granted in time **[New]** | AI features unavailable at launch | AI is off by default (`AI_PROVIDER=none`); rule-based checks keep working |
| Offline sync conflicts in the field | Lost or duplicated inspection data | Append-only evidence, versioned edits, conflict screen, field pilot |
| Regulatory scope not yet confirmed | Rework of notices, retention, SLA timers and data handling | Legal and Compliance review before design freeze; SLA targets in configuration |
| Too few engineers to embed in six pods | Pods stall or get uneven support | Share engineers across pods by phase and staff pods on the critical path first |

### 8.5 Open questions

1. Which UAT, security testing and compliance sign-off windows fit before the October 27, 2026 go-live? (Proposed: §8.2.)
2. Which jurisdictions and lines of business are in scope (affects regulation, templates, currency, SLA limits and languages)?
3. What are the adjuster reserve authority limits and settlement approval tiers per segment?
4. Which legacy systems and payment portals are in scope, and what interfaces do they expose?
5. Which Claude deployment platform and data-handling terms has Security approved for claim data (decision D2)?
6. ECS Fargate or EKS for the container platform?
7. **[New]** Who is the named DPO / grievance officer, and what are the statutory breach-notification windows per jurisdiction?
8. **[New]** Is the customer address required at FNOL for all segments, or only for check payments?

---

## Appendix A. Implementation status against this PRD (as of October 27, 2026) **[Updated in 1.5]**

Status key: **Done**: implemented and covered by tests · **Partial**: some of the requirement exists · **Not started**.

| Requirement | Status | Evidence in repository / gap |
|---|---|---|
| FR-X1 Unified claim view | Partial | Claim workspace with role-filtered tabs including stage, severity, SLA clocks, coverage, reserves ledger, approval steps, closure & recovery (`ClaimWorkspace.js`, `CLAIM_TABS`). Legacy-source data appears only through `claim_xref`; no GraphQL |
| FR-X2 Task engine | Done | Owner user or role queue, blocking flag, due dates, overdue sweep and unclaimed-queue escalation; `task_sources` table ready for legacy ingestion |
| FR-X3 Reverse review | Done | `reviews` rows for reserve, evaluation, compliance and closure checkpoints; settlement steps; self-review blocked in API and database |
| FR-X4 Agent contract | Done | `ai_runs` with agent, `prompt_version`, `input_hash`, numeric confidence, `needs_human`, `human_decision`; agent audit rows |
| FR-X5 Notifications | Partial | In-app plus email delivery rows; email adapter logs only; no SMS or push. Rejections have their own templates and are marked in the Notification Center (1.5) |
| FR-X6 Segment configuration | Done | `segment_config` with four-eyes approval (Configuration page) drives required artifacts, SLA hours and severity. The fraud review threshold is stored and editable but nothing routes on it yet (see §3.3) |
| FR-X7 Legacy task ingestion | Partial | Schema (`task_sources`, `integration_sync_runs`, `claim_xref`) and Integrations page; no live connectors |
| FR-X8 Workflow integrity | Done | `shared/workflow.js` → `workflow.service.js` + generated trigger migration (latest `20261027000013`) |
| FR-X9 Idempotency | Done | Submission key; `Idempotency-Key` on payment issue |
| §2 RBAC (eight roles) | Done | Permission map, claim scopes, RLS, navigation and tests per role, including the Claims Operations Manager (1.3). Checked row by row against §2.2 on Oct 27; gaps: clients cannot enter their own payee details or export their own data |
| §0.5 Intake routing to the Claims Operations Manager | Done | `intakeRouting.service.js`: lowest-workload assignment at submission, on-behalf claims kept by their creator, role-queue fallback; `intake-routing.test.js` |
| §0.5 Payee verified at intake | Done | `GET/PUT /claims/:id/payee`, `payeeVerified` guard on leaving intake, verifier ≠ person who entered the details |
| §2 ABAC monetary authority | Done | `authority_limits` + `user_attributes` via `effective_limit()`, checked in API and triggers for reserves and settlement steps |
| §2.3 Claims-Manager-only closure | Done | Adjuster closure requests; only `OPS_MANAGER` transitions to CLOSED/REOPENED |
| §0.6 Adjuster settlement approval (1.4) | Done | Adjuster settlement limits (15,000 / 30,000), `settlementApproverRole`, assigned-adjuster rule in `authority.service.js` and `enforce_settlement_step`, adjuster settlement queue scoped to own claims; migration `20261027000012`; tests in `approvals-compliance.test.js` and the lifecycle test |
| §2.3 Approver ≠ issuer, changer ≠ verifier | Done | `enforce_issuer_not_approver` trigger and payee CHECK, mirrored in services |
| §2.3 Four-eyes governance | Partial | Configuration proposals and authority limits; role grants are single-approver but never self-grants |
| §2A Customer data collection | Partial | Privacy-notice consent at registration, declaration consent at submission, encrypted claimant contact and bank details, audited customer records, Indian mobile format, loss city and country (1.5). No postal address, email or phone OTP verification, notification preferences, self-service export, erasure requests or retention anonymization job |
| §3.1 FNOL | Done | Six-step wizard, eligibility, duplicate detection, idempotent submit, policy snapshot, required artifacts, acknowledgement clock. 1.5: no future loss dates on any save, insured name fixed from the policy, address + city + country, required documents before step 4 can be left, +91 mobile field |
| §3.2 Coverage verification | Partial | Recorded coverage results with clause references against the snapshot; no AI clause matching |
| §3.3 Triage | Partial | Severity from segment thresholds, fraud score and band, manual assignment with workload; no routing agent; fraud scores above the threshold are not yet routed to a special investigation queue |
| §3.4 Documents | Partial | Versioned documents, review, artifact requests, reminders, AI extraction with confidence. No malware scan or camera capture |
| §3.5 Reserves | Done | Ledger with authority decision node; manager approve/modify/reject/return; release on closure |
| §3.6 Evaluation & decision | Partial | Versioned evaluations with liability and decision; no denial-letter drafting |
| §3.7 Settlement | Partial | Authority-routed approval steps (assigned adjuster within limit, otherwise Claims Manager), payee verification, payment blocks; customers see settlement amounts masked until revealed (1.5); no sanctions screening, payee agent or release document |
| §3.8 Payment | Partial | Idempotent issue, blocks, resolution, manual reconciliation on a **simulated** adapter; no daily reconciliation job, reissue or stop-payment |
| §3.9 Closure & recovery | Done | Closure requests, reserve release, subrogation and salvage tracking |
| §3.10 SLA clocks | Done | Stage clocks with pause on client-owed documents and holds, escalation levels 1–2, SLA attainment report. Timeline shows date and time per event (1.5). The customer tracker does not yet show the expected date of the next step |
| §4 PWA, offline, camera | Not started | Responsive web app only |
| §5 Schema | Done | Migration `20261022000007` (§5.5) |
| §5.4 Audit hash chain | Done | Chained `audit_logs` with `verify_audit_chain()` and a verification button for Compliance & Security; no Object Lock export |
| §6.0 Docker / AWS / IaC / CI | Not started | |
| §6.4 Claude agents | Partial | Intake parser and claim summarizer on `claude-opus-5-5` with schema output, explicit effort and server-side fallback; other agents not built |
| §7.2 MFA / SSO | Not started | Email + password (API sign-in on PostgreSQL) |
| §7.2 Field-level encryption | Done | AES-256-GCM with HKDF-derived keys (`FIELD_ENCRYPTION_KEY`) for bank details and claimant contact; HMAC for duplicate detection |
| §7.2 Upload malware scan | Not started | Extension and content sniffing, size limit |
| §0.7 Indian rupees (1.5) | Done | `formatMoney` (en-IN, INR) in the client, `formatInr` in server messages, currency defaults and rows `INR` |
| §0.7 Policy renewal requests (1.5) | Done | `POST /policies/:id/renewal-requests`, `GET /policy-renewals`, `POST /policy-renewals/:id/decision` (`renewals.service.js`), `POLICY_RENEWAL` task, My Policies button, Policy Renewals page; `portal-enhancements.test.js` |
| §0.7 Claim filters and search removal (1.5) | Done | My Claims filters by status, claim type and submission period; header, My Claims, claims queue and payment queue searches removed |
| §0.7 Portal layout (1.5) | Done | New customer dashboard banner, pages open at the top, wizard steps scroll to the top, wide tables scroll inside their cards. Verified by build and tests only; to be checked by hand on desktop, tablet and phone |
| §6.0 Mobile app (PWA), SSO/MFA, legacy connectors, real policy and payment systems | Not started | See §4, §6.5 and §7.2 |

## Appendix B. Where the current code isolates platform choices

| Concern | Adapter | Current implementations |
|---|---|---|
| Database | `server/src/db/index.js`, `migrate.js` | `pgExecutor.js` (any PostgreSQL, including RDS) |
| Authentication | `server/src/services/authProvider.js` | Email + password on `auth.users`, HS256 session tokens |
| File storage | `server/src/services/storage.service.js` | PostgreSQL `document_files` |
| AI | `server/src/services/ai.service.js` | Anthropic, disabled |
| Payments | `server/src/services/paymentAdapter.js` | Simulated |
| Email | `server/src/services/email.service.js` | Console, disabled |

The code walkthrough is in [WALKTHROUGH.md](WALKTHROUGH.md).
