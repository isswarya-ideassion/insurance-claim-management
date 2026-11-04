# Beacon — Knowledge Transfer

*For business analysts, claims staff and colleagues. No engineering background assumed.*

---

## 1. What Beacon is

**Beacon is HarborPoint's own claims intelligence.** It reads the facts already on a claim and recommends what a claims officer should consider — coverage, severity, risk indicators, which adjuster to assign, how much to reserve, what to put in a denial letter, whether a payee needs checking, and whether money can be recovered from a third party.

The name is the point. A beacon guides a vessel; it does not steer it. **Beacon never decides anything.** Every output is a suggestion that a named person with the right permission must accept or discard, and the system records who decided and when.

We built it ourselves. It runs inside our own application, on our own servers. There is no subscription, no external service, no per-use charge, and no claim data leaves our infrastructure.

---

## 2. Is this "synthetic AI"? The honest answer

This question deserves a straight answer, because the word "AI" is used loosely and you will be asked.

**Beacon is not fake, and it is not a simulation.** Nothing is mocked, hardcoded, or staged to look clever in a demo. Every number it produces is genuinely computed from real claim data at the moment you ask.

**Beacon is also not ChatGPT-style AI.** It does not use a large language model. It does not write original prose. It cannot hold a conversation or answer a question nobody wrote a rule for.

What it actually is, in industry terms:

| Part of Beacon | Technique | Learns from data? |
|---|---|---|
| The six claim agents | Rules engine (expert system) | No — rules we wrote |
| Unusual-claim detection | Isolation Forest (machine learning) | **Yes** — trains on our own claims |
| Document type suggestion | Naive Bayes classifier (machine learning) | **Yes** — trains on our own labels |
| Reading document images | Classical computer vision + OCR | Partly — classifier is trainable |
| Fraud-ring detection | Graph analysis (union-find) | No — facts only |

So: **two of the five components genuinely learn from our data.** The rest are deterministic rules. By the textbook definition this is all AI; by what most people mean today ("like ChatGPT"), only partly.

**Say this to stakeholders:** *"Beacon is a rules-and-statistics engine we built in-house. Parts of it learn from our own claim history. It is not a language model and does not generate text."*

**Do not say:** *"We built our own AI model like ChatGPT."* That would be untrue.

### Why being deterministic is an advantage here

For a regulated insurance file, predictability beats cleverness:

- **Reproducible** — the same claim always produces the same recommendation. A language model can give two different answers to the same question on two different days.
- **Auditable** — every number traces to a rule or a calculation a person can follow and challenge. "Why did this score 60?" has an exact answer.
- **Nothing invented** — Beacon cannot cite a policy clause that does not exist, or produce a fraud code that is not in our approved list. Both are structurally impossible, not merely unlikely.
- **No data leaves** — relevant for IRDAI expectations and for customer bank details.

---

## 3. What happens in the live application

When a claims officer opens a claim and presses an agent button, this is the sequence — and it finishes in well under a second, with no network call to anyone:

```
1. The system gathers the facts from our database
     (policy clauses, adjuster workloads, comparable settlements,
      payee history, documents on file)
2. Beacon applies its rules to those facts
3. The suggestion is saved permanently, with its inputs
4. The officer sees it on screen, with the reasoning
5. The officer APPLIES or DISCARDS it
6. Who decided, and what they decided, is recorded
```

Step 5 is not optional and cannot be skipped. The database itself enforces it.

### The six agents, in business terms

| Agent | What a user sees | How Beacon works it out |
|---|---|---|
| **Coverage check** | Which policy clause covers (or excludes) this loss | Matches the loss type against the policy wording. **Always marked for human review** — it finds the clause that mentions the peril, not the clause that governs it |
| **Triage** | Severity, complexity, risk score, suggested adjuster | Severity from the claimed amount vs segment thresholds; risk score from matched indicators × their weights; adjuster by experience then workload |
| **Reserve** | A low / likely / high reserve range | The 25th, 50th and 75th percentile of what comparable settled claims actually paid |
| **Denial letter** | A complete draft letter | A fixed template with the claim's facts filled in. Always contains the right-to-review and grievance/Ombudsman notices |
| **Payee check** | Which payee details need confirming before payment | Six checks against payment history — new account, recent change, name mismatch, shared account, payee on multiple claims, third-party payee |
| **Subrogation** | Whether we can recover from a third party, and by when | Third parties on the file plus evidence; limitation date calculated from the loss date |

### Things it deliberately refuses to do

- **It will not conclude fraud.** The risk score is an indicator for a compliance officer. Any output mentioning a fraud conclusion is automatically discarded by the system.
- **It will not recommend releasing or holding a payment.** Same automatic rejection.
- **It will not exceed a coverage confidence of 0.6** — below the threshold at which anything could be auto-accepted. Coverage always reaches a person.
- **It will not summarise claims or extract fields from free text.** Those two features need a language model. Beacon says so plainly rather than returning something empty that looks like an answer.

---

## 4. Switching it on

One line in `server/.env`:

```
AI_PROVIDER=beacon
```

Then restart. The agent panel works immediately — no model to download, nothing to install, no key to buy.

The other options remain available: `ollama` (a free model on a machine we run) and `anthropic` (a paid service). Those two can summarise claims and read documents, which Beacon cannot. The three can be swapped by changing that single line.

---

## 5. What Beacon cannot do — read this before promising anything

| Limitation | What it means in practice |
|---|---|
| **No claim summaries, no field extraction from text** | These need a language model. Beacon refuses them explicitly. |
| **Coverage matching is keyword-based** | It finds the clause mentioning the peril, not necessarily the clause that legally governs. A human must confirm every coverage call. |
| **Denial letters are templates** | Same structure every time, with facts filled in. Good for regulatory consistency; it is not bespoke drafting. |
| **Reserve needs history** | Fewer than three comparable settled claims and it says so, lowers its confidence, and falls back to the adjuster's estimate. |
| **The unusual-claim model will not run yet** | It needs at least 50 claims to train; the book currently has 17. It refuses rather than producing a meaningless model. |
| **Document reading handles printed text only** | Not handwriting, and not a typeface it has not been trained on. |
| **None of this is visible in the screens yet** | Fraud-ring detection, unusual-claim scoring and document reading have no user interface. Only the six agents above appear in the application. |

---

## 6. Questions you will be asked

**"Is it accurate?"**
For the deterministic parts the question does not apply — the payee check reproduces facts already in the database exactly. For the learned parts: document type classification measured **37.5%** on our current demo documents, because those documents are placeholder text with nothing real to learn from. The same classifier exceeds 80% on realistic document text. It must be retrained on real paperwork before anyone relies on it, and the measured accuracy is stored and shown alongside each suggestion.

**"Will it replace staff?"**
No, and it is built so it cannot. Every suggestion needs a person to apply it; bank-detail verification requires two different people, enforced by the database. What changes is capacity — a compliance officer reviews a ranked shortlist instead of scanning every file.

**"What does it cost to run?"**
Nothing beyond the servers we already have. No licence, no API charges, no GPU.

**"Can we show the customer how a decision was made?"**
Yes, better than with a language model. Every suggestion stores its inputs, its version, and the reasoning; the decision record names the person who applied it.

**"Why not just use ChatGPT / Claude?"**
For claim summaries and reading photographed documents, we may well should — those genuinely need a language model, and it is inexpensive. For scoring, routing and reserving, a rules engine is better: reproducible, auditable, free, and incapable of inventing a clause.

---

## 7. Technical reference

| | |
|---|---|
| Configuration | `AI_PROVIDER=beacon` |
| Provider name recorded on each run | `beacon` |
| Version recorded on each run | `beacon-rules/2026-10-29` |
| Code | `server/src/services/intelligence/beacon.provider.js` |
| Tests | `server/tests/unit/beacon.test.js` (18 tests) |
| Audit trail | `ai_runs` table — immutable; results cannot be edited after the fact |
| Engineering detail | `docs/AI-INTELLIGENCE.md` |
