# Own Intelligence Layer — KT

Replaces the LLM provider with models we build, train and host ourselves. No Ollama, no API keys, no GPU, no extra hosting cost.

## 1. The core finding

The six claim agents in `server/src/modules/automation/agents.service.js` do **not** feed raw text to a model. Each `prepare()` builds a small JSON object of facts the system already computed in SQL, and the LLM only reasons over that.

That means the hard part — getting clean, structured, minimized facts — is already done. The LLM is a thin layer on top, and it is replaceable one agent at a time.

Two agents are already almost entirely deterministic in our own code:

- **`payee-anomaly`** — `payeeFacts()` computes all six `PAYEE_ANOMALY_CODES` in SQL (`NEW_BANK_DETAILS`, `RECENT_BANK_CHANGE`, `DUPLICATE_PAYEE`, …) before the model is called. The model re-describes signals we already have.
- **`triage-router`** — `fraud_reason_codes.weight × SEVERITY_FACTOR` is already a scoring model in the database. `severity_thresholds` comes from segment config. `triageCandidates()` already returns each adjuster's open load and per-claim-type experience.

## 2. Replacement per agent

| Agent | Own-intelligence method | Training data needed |
|---|---|---|
| `payee-anomaly` | Already computed — just return `facts.signals` and drop the model call | None |
| `triage-router` | Weighted score (in DB) + greedy least-loaded assignment over `triageCandidates()` | None |
| `reserve-recommender` | k-NN quantile regression over the comparables query already written — `low`=P25, `point`=P50, `high`=P75 | Settled claims (have 24) |
| `coverage-checker` | `evaluatePolicyEligibility()` for hard checks + TF-IDF peril→clause matching over `policyClauses()` | Policy wordings |
| `denial-letter-drafter` | Template engine with clause slots. `NOTICE_CHECKS` already validates required regulator language | None |
| `subrogation-assessor` | Decision tree on loss_type × third-party presence × documents; limitation date is date math from `LIMITATION_TABLE` | Closed recoveries |

Order of work: payee → triage → reserve → denial → subrogation → coverage. The first two need no training data and no new tables.

## 3. The learning loop already exists

`ai_runs` has exactly the columns a supervised trainer needs:

```
output          jsonb     what was proposed
confidence      numeric   how sure it was
human_decision  text      ACCEPTED | REJECTED   <-- the label
applied_fields  text[]    which parts were kept <-- partial credit
decided_by      uuid      who judged it
```

Every time staff accept or discard a suggestion, a labeled training row is produced. `agents.service.js` already writes `human_decision` on apply and discard.

**Current state (Neon):** 9 runs — 4 succeeded, 5 failed because no AI provider is configured there. So there is no usable training signal yet. The deterministic agents (payee, triage) must ship first; they start generating labels, and the statistical agents train on those later.

## 4. Where it runs

Plain JavaScript in the existing Express app. A new `server/src/services/intelligence/` beside `ai.service.js`, exposed as a third provider:

```js
// env.js
AI_PROVIDER: z.enum(['none', 'anthropic', 'ollama', 'local'])
```

- Scoring is arithmetic over a few hundred rows — microseconds, no new process.
- Model "weights" live in a Postgres table, not a binary file.
- Retraining is a nightly job on the Vercel Cron already wired at `vercel.json` → `/api/internal/cron/jobs`.
- Runs inside the current function. No new infrastructure, no cost.

## 5. What this does not do

Text generation. A template engine writes denial letters; it does not paraphrase. For regulator-facing letters that is an advantage — output is auditable and the wording is fixed — but it is a real limitation to state plainly rather than discover later.

Document extraction from images (`OLLAMA_VISION_MODEL`) also stays unsolved. That genuinely needs a vision model; OCR plus field regex covers typed documents only.

## 6. Shipped: organised-fraud ring detection

Detects the shell-company pattern — several "unrelated" entities registered at one co-working address, claiming, with no office there when an inspector visits.

**Why it needed new tables.** The system stored no registered address for an entity. `claims` has only `loss_city` / `loss_country`; `policies` has `insured_name` and no address at all. The pattern was undetectable because the data was never captured. `20261029000016_fraud_rings.sql` adds `entity_premises`, `premises_verifications`, `fraud_rings`, `fraud_ring_members` and seven reason codes.

**The trick — hash the building, not the address.** Shell entities at one tower differ only by suite ("Suite 1104" vs "Unit 1210"). Hashing the full address makes them look unrelated, which is what the arrangement relies on. `addressNormalizer.js` parses the unit out, expands abbreviations, collapses city renames (Bengaluru→Bangalore), fuses initials (`M.G.`→`mg`), strips the company name out of its own address line, then sorts tokens before hashing. Verified: those two addresses above produce one identical `premises_hash`.

**Scoring is per ring, not per claim.** Entities are joined by union-find over facts only — identical building hash, identical bank-account HMAC. Each claim alone is unremarkable; the component is the signal.

**The gate is the whole design.** A co-working tower legitimately hosts hundreds of real companies, so `SHARED_REGISTERED_ADDRESS` carries only weight 15 and **cannot raise a ring above LOW on its own**. It needs corroboration from a failed site visit, a shared bank account, correlated timing, or rapid claiming after inception. Without this, every genuine startup in the building gets flagged.

Measured on the local database:

| Scenario | Result |
|---|---|
| 2 entities, same building, failed site visits | **70/100 HIGH** |
| Same 2 entities, same building, no failed visit | **not reported** |

Run it: `node server/scripts/fraud-rings.js demo` (plants the scenario) or `detect` (the nightly pass). 9 unit tests in `server/tests/unit/fraudRing.test.js`.

**Known limits.** Detection needs `entity_premises` to be populated — nothing fills it at intake yet, so this runs on backfilled data until an intake capture step is added. Entity linking by shared phone/email is not implemented: `claim_parties.contact_encrypted` is AES-GCM ciphertext, so it needs a blind index (keyed HMAC) like `payees.bank_details_hash` before it can be joined on.

## 7. Shipped: the claim-anomaly model (genuine ML)

Sections 1–6 are rules — deterministic, hand-weighted, nothing learned. This section is an actual trained model.

**Algorithm: Isolation Forest** (Liu, Ting & Zhou, 2008), implemented in `isolationForest.js`. Chosen because it is **unsupervised**: we have no confirmed-fraud labels, so nothing supervised can train. It isolates points by random splits — anomalies sit in sparse regions and isolate in fewer splits. It learns the shape of *our* book: a claim is not unusual in the abstract, only relative to what this company actually sees.

**Trained on our data, stored as data.** The fitted trees plus the population statistics live in `ml_models.payload` as JSONB — no file, no object storage, no model server. A serverless function loads it on a cold start, and every score in `claim_anomaly_scores` carries the model version that produced it. `ml_models_one_active` enforces one active version per model rather than assuming it.

**Features are grounded in Indian general-insurance practice** (`features.js`):

| Feature | Why it matters in an Indian book |
|---|---|
| `within_health_waiting_period` | Standard 30-day initial waiting period; payable only for accident |
| `within_free_look` | IRDAI-mandated 15-day window where premium is still refundable |
| `intimation_delay_ratio` | Delay scaled to the norm per line — 10 days is late for motor, routine for property |
| `amount_roundness` | Genuine settlements are invoice-built and land on awkward figures; fabricated ones cluster on ₹50,000 / ₹1,00,000 |
| `just_below_authority_limit` | Structuring just under a delegated-authority threshold to avoid senior review |
| `monsoon_loss` | June–September. Genuine flood claims cluster; the model needs the season so a monsoon surge is not read as anomalous |
| `days_to_policy_expiry` | Claiming in the final weeks before a renewal decision |
| `entities_at_premises` | Feeds the ring work in §6 into the model |

Protected attributes and their proxies are excluded by construction — no name, gender, age, or location finer than city. `claim_type` is deliberately *not* one-hot encoded: random-split forests degrade when the space is padded with sparse indicators, so line of business enters through `amount_robust_z` instead.

**Measured, not assumed.** On 300 synthetic Indian motor/health claims with two fraud-shaped claims planted and never labelled, the model ranked both **above the entire ordinary book**. On a clean book with nothing planted, ~2% land above `UNUSUAL` — that is the alert budget, and the test asserts it stays under 5%. Past that a reviewer stops reading the queue, which is worse than no model.

**It will not train on your data yet, by design:**

```
Need at least 50 submitted claims to train; the book has 17.
```

It refuses rather than fitting noise and calling it intelligence. Run `node server/scripts/anomaly-model.js train | score | top`.

**What it is not.** An outlier detector, not a fraud detector. Large legitimate claims are outliers too. It produces a triage ordering for human attention, never a finding. Making it predict *fraud* specifically needs labels — which §6's `fraud_rings.status` (`CONFIRMED` / `DISMISSED`) starts collecting.

## 8. Shipped: document intelligence (the Document Reviewer blocker)

The blocker was "extraction needs a vision model we don't have". That was true for photographs, and false for everything else — most Indian claim paperwork arrives already digital (HIS hospital bills, GST tax invoices, e-FIR copies, policy schedules) and carries a real text layer.

Three pieces, none of which needs a model provider:

1. **`pdfText.js`** — reads the PDF text layer directly (handles FlateDecode), with no dependency. `hasTextLayer` distinguishes a readable PDF from a scan, so a photograph is reported honestly as `needsOcr` rather than silently returning `""`.
2. **`indianFields.js`** — extracts the statutory formats: GSTIN, PAN, IFSC, CIN, vehicle registration. These are checksummed fixed-width formats defined by law, so a regex beats a language model — it is exact and cannot hallucinate a plausible PAN. Amount selection is hint-weighted so "Grand Total" wins over "CGST". Dates parse **DD/MM/YYYY**, since misreading 03/04/2026 can move a claim outside the policy period.
3. **`naiveBayes.js`** — supervised `doc_type` classifier. Unlike §7 this has labels today: every row in `documents` already carries the class a reviewer assigned.

**Aadhaar is deliberately never extracted.** It is masked on sight. Capturing it creates a UIDAI compliance burden this system is not built for, and no claim decision needs it.

### Measured on the real database — and why the first number was wrong

| Measurement | Result |
|---|---|
| Documents with a readable text layer | **32 of 32** |
| Classifier accuracy, as first reported | 90.6% |
| Classifier accuracy, leakage removed | **37.5%** |

The 90.6% was **label leakage**. The seed PDFs literally contain the answer:

```
Document type: PHOTOS
```

The classifier was reading the label off the page. With that line and the filename removed, real accuracy is 37.5% across 6 classes — better than the 16.7% random baseline, but weak.

The cause is the corpus, not the code: the seed documents are near-identical boilerplate with no document content to learn from. On a realistic corpus (invoice / medical / FIR text) the same classifier cross-validates above 80% in `documentIntelligence.test.js`. **Retrain on real paperwork before trusting the suggestion**, and show `classifierAccuracy` in the UI so a reviewer knows what it is worth.

### What the reviewer actually gets

`analyseDocument()` returns a suggested `doc_type` with its confidence, extracted identifiers, and field proposals shaped to mirror `EXTRACTABLE_CLAIM_FIELDS`. Below 0.65 confidence the type is a hint, never a pre-selection. Every proposal carries `needsConfirmation: true` and the source text it came from — the contract that nothing is written without a person is unchanged. This removes the typing, not the checking.

## 9. Shipped: our own vision model

Written from scratch in `services/intelligence/vision/`. No npm package, no API, no model file, no GPU. Four stages:

1. **`imageCodec.js`** — PNG and baseline JPEG decoders. Node ships no image decoder, so this is part of the deliverable rather than a dependency. Decodes straight to a grayscale plane; colour would triple memory for no gain. WebP (VP8) is reported as unsupported rather than mishandled.
2. **`preprocess.js`** — **Sauvola adaptive binarisation**, skew estimation by projection profile, bilinear deskew, morphological closing, and a readability assessment.
3. **`ocr.js`** — connected-component analysis, geometric line/word grouping, and a nearest-neighbour glyph classifier over 8×8 ink-coverage descriptors.
4. Wired into `documentIntelligence.service.js`, so images now take the OCR path instead of returning `IMAGE_NEEDS_OCR`.

### Three findings from building it

**Sauvola, not Otsu.** A global threshold cannot separate ink from paper when a hard shadow makes shaded paper darker than lit ink — and that is the normal case for a handheld photo. Measured: under a hard shadow, adaptive binarisation reads >90% of characters where a global threshold reads <60%.

**Deskew the greys, not the bitmap.** Rotating a one-bit image with nearest-neighbour sampling shreds thin strokes; characters break into fragments and component analysis then sees pieces, not glyphs. `prepareDocument()` thresholds once to *measure* skew, straightens the continuous-tone image, then thresholds for real.

**Margin must be measured against a different character.** The classifier stores several templates per character (one per rendered scale). Measuring confidence against the next-best *template* compares a letter to itself at another size, collapsing the margin to zero and rejecting correct reads as `?`. It must compare against the best template of a different character.

### Measured

| Condition | Result |
|---|---|
| Clean rendered page | 100% |
| Hard shadow (adaptive) | >90% |
| Hard shadow (global threshold) | <60% |
| 4° skew + hard shadow | >80% |

Character accuracy is measured by **edit distance**, not position-by-position. A single spurious blob inserts one character and misaligns everything after it — positional comparison scored 48% for output that was one character wrong.

### What it cannot do

Handwriting. Unfamiliar typefaces without training — the built-in templates are a 5×7 bitmap font, included so the pipeline is provable end to end, not because real documents use it. `trainTemplates()` exists because the classifier is meant to be taught your own documents from labelled samples; until it is, expect poor accuracy on real scans. Progressive JPEG and WebP are unsupported.

This is classical computer vision, not a learned vision model. It is genuinely ours and genuinely free, and it is weaker than a hosted vision API on anything it has not been trained for.

## 10. Wired in

`fraudRings` and `anomalyScoring` now run in `jobs.js`, so they execute on the Vercel Cron already configured. Both are no-ops on an empty book rather than failures. They run in the nightly pass rather than on the request path because each reads the whole book — far too much work to do while a user waits.

Still **not** wired: no API route or UI for any of this, and nothing populates `entity_premises` at intake.

## 10. What stays unchanged

The advisory contract. `needsHuman`, the apply/discard flow, `ai_runs` immutability, RBAC on apply, and fraud-score masking in `maskTriage()` all stay exactly as they are. We are swapping how a suggestion is produced, not whether a person reviews it.
