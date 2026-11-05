# Demo & Manual Test Guide

Every step below was run against the local database before this guide was written. Claim numbers, logins, tabs and expected results are real, not illustrative.

---

## 1. Start the application

PostgreSQL runs as a Windows service and should already be up.

```powershell
cd c:\harbourpoint\insurance-claim-management
npm run dev
```

Wait for both lines:

```
[client]  ➜  Local:   http://localhost:5173/
[server]  HarborPoint Claims API listening on http://localhost:4000/api
```

Open **http://localhost:5173**.

**If the client says port 5173 is in use** it will start on 5174 instead, and sign-in will fail on CORS. Stop it, free the port, start again:

```powershell
Get-NetTCPConnection -LocalPort 4000,5173 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### Confirm the AI is on before you demo

```powershell
# expect: provider = beacon
curl.exe http://localhost:4000/api/health
```

`"aiConfigured": true` means Beacon is live. If it says `false`, check `AI_PROVIDER=beacon` in `server/.env` and restart.

---

## 2. Logins

Password for every account: **`HarborDemo!2026`**

| Role | Email | Use for |
|---|---|---|
| Claims Ops Manager | `ops.olivia@demo.harborpoint.test` | Coverage check, triage |
| Ops Manager | `manager.maria@demo.harborpoint.test` | Denial letter, approvals |
| Adjuster | `adjuster.adam@demo.harborpoint.test` | Reserve, subrogation |
| Payment Operator | `payments.priya@demo.harborpoint.test` | Payee check |
| Compliance | `compliance.carlos@demo.harborpoint.test` | Fraud score (only role that sees the number) |
| Client | `customer.alice@demo.harborpoint.test` | Customer's own view |

> **Staff cannot run an agent on a claim they own.** If a button is missing, you are probably signed in as the owner of that claim.

---

## 3. The six agents — verified routes

To reach any agent: **Claims** → open the claim → the tab below → the agent panel → **Run**.

| # | Agent | Sign in as | Claim | Tab | What you will see |
|---|---|---|---|---|---|
| 1 | Coverage check | ops.olivia | **HPC-2026-000102** | Policy & Coverage | `COVERED`, confidence 0.6, 1 covering clause |
| 2 | Coverage check | ops.olivia | **HPC-2026-000101** | Policy & Coverage | `NEEDS_REVIEW`, confidence 0.3 — no clause names this loss |
| 3 | Triage | ops.olivia | **HPC-2026-000105** | Overview | Severity MEDIUM, complexity 1, risk band LOW, suggests **Adam Brooks** |
| 4 | Reserve | adjuster.adam | **HPC-2026-000106** | Reserves | Line OWN_DAMAGE, point ₹2,350, **0 comparables** |
| 5 | Subrogation | adjuster.adam | **HPC-2026-000106** | Closure & Recovery | Likelihood LOW, type NONE, limitation **2029-10-17** |
| 6 | Payee check | payments.priya | **HPC-2026-000112** | Approvals | 1 anomaly — `PAYEE_ON_MULTIPLE_CLAIMS` |
| 7 | Denial letter | manager.maria | **HPC-2026-000101** | Evaluation | Full draft letter *(needs step 4 first)* |

---

## 4. The demo to actually run — the chain

This is the strongest five minutes, because it shows the human overruling the AI and the system reacting.

**As `ops.olivia`, claim HPC-2026-000101, Policy & Coverage tab**

1. **Run** the coverage check. Beacon returns **NEEDS_REVIEW at confidence 0.3** and says no clause in the wording names this loss.
   *Point to make:* it did not guess. Low confidence is the honest answer, and coverage can never auto-apply — the ceiling is 0.6, below the 0.8 bar.

2. **Change the result to `NOT_COVERED`**, add a note, **Apply**.
   *Point to make:* the officer overrode the AI. The claim record now carries the officer's decision, and the audit log names her, not Beacon.

**Now sign in as `manager.maria`, same claim, Evaluation tab**

3. **Run** the denial letter. Before step 2 this was blocked with *"a denial letter can be drafted only when the evaluation recommends denial or coverage was recorded as not covered."* Now it produces a complete letter.

4. Read what it flags: **0 clauses cited, 2 missing notices.** Beacon is telling the manager the letter is not ready to send because the health policy has no matching exclusion.
   *Point to make:* this is the system refusing to produce something that looks finished but isn't.

5. Edit the letter, **Approve**. It is stored as a PDF on the claim with the manager named as approver.

---

## 5. What to say about what it is

If someone asks "is this real AI?":

> Beacon is a rules-and-statistics engine we built in-house. Parts of it learn from our own claim history. It is not a language model and does not generate text.

Do **not** say "we built our own AI like ChatGPT" — someone will immediately ask it to summarise a claim, and it will correctly refuse.

Full background for your BA: `docs/BEACON-KT.md`.

---

## 6. Set expectations before you start

These are real limits of the demo data, not bugs. Say them *before* someone notices.

| What they'll see | Why |
|---|---|
| Reserve shows **0 comparables** and low confidence | There are no settled MOTOR claims in the demo book. Beacon says so rather than inventing a range. |
| Subrogation says **LOW / NONE** | No third parties recorded on any demo claim. With one, it returns HIGH and a referral date. |
| Denial letter cites **0 clauses** | The health policy has no exclusion matching this loss. Beacon flags it instead of citing something wrong. |
| The **fraud score is hidden** for most roles | Only Compliance sees the number; others see the band. Sign in as `compliance.carlos` to show the score. |
| **No screen** for fraud rings, anomaly scores or document reading | Those run as a nightly job and from the command line. Not in the UI yet. |

---

## 7. Features with no UI — command line only

Run these in a second terminal if you want to show them. They do not appear in the application.

```powershell
cd c:\harbourpoint\insurance-claim-management\server

# Fraud ring: two shell companies at one co-working address
node scripts/fraud-rings.js demo      # plants the scenario, then detects
node scripts/fraud-rings.js detect    # detection only

# Document reading
node scripts/doc-intelligence.js analyse

# Unusual-claim model (will refuse: needs 50 claims, book has 17)
node scripts/anomaly-model.js train
```

The ring demo prints a **70/100 HIGH** ring. Worth showing: the same two companies with no failed site visit score **nothing at all** — a shared address alone is not evidence, because real companies share co-working addresses every day.

> `demo` writes fictional data and refuses to run with `NODE_ENV=production`.

---

## 8. If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Agent panel says "not configured" | `AI_PROVIDER` missing or wrong | Set `AI_PROVIDER=beacon` in `server/.env`, restart |
| API returns 503 on everything | `AI_PROVIDER` set to an invalid value | Only `none`, `anthropic`, `ollama`, `beacon` are accepted |
| Sign-in fails, console shows CORS | Client started on 5174 | Free port 5173 and restart (section 1) |
| **Run** button missing | Wrong role, wrong claim stage, or you own the claim | Check the table in section 3 |
| "Already reviewed" | That run was applied or discarded | Run the agent again — it creates a new run |
| Coverage check won't run | Claim is past intake | Only SUBMITTED, POLICY_VERIFICATION or REOPENED |
| Reserve won't run | Not the assigned adjuster, or not in Investigation | Sign in as `adjuster.adam` on HPC-2026-000106 |

### Reset the demo data

```powershell
cd c:\harbourpoint\insurance-claim-management
npm run db:seed-demo
```

---

## 9. One-minute pre-demo check

```powershell
# 1. both ports up
Get-NetTCPConnection -LocalPort 4000,5173 -State Listen | Select-Object LocalPort

# 2. AI is Beacon
curl.exe http://localhost:4000/api/health
```

Then sign in as `ops.olivia`, open **HPC-2026-000105**, Overview tab, and run Triage. If an adjuster name comes back, everything works.
