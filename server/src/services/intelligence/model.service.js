import { buildPopulationStats, featureMedians, featureNames, toVector } from './features.js'
import { anomalyScore, deserializeModel, explainScore, serializeModel, trainIsolationForest } from './isolationForest.js'

/**
 * Trains and serves the claim-anomaly model from our own claim history.
 *
 * The model is a row in ml_models, not a file: a serverless function loads it
 * on a cold start with no object storage and no model server, and every score
 * carries the id of the model version that produced it.
 */

export const MODEL_NAME = 'claim-anomaly'
const ALGORITHM = 'isolation-forest'

/**
 * Below this the population does not describe a book of business and the
 * forest would memorise noise. Indian general-insurance mix across five lines
 * needs a few hundred claims before "unusual" means anything.
 */
export const MIN_TRAINING_ROWS = 50

const band = (score) => (score >= 0.72 ? 'EXTREME' : score >= 0.62 ? 'UNUSUAL' : score >= 0.55 ? 'ELEVATED' : 'TYPICAL')

const TRAINING_SQL = `
  select c.id as claim_id, c.claim_number, c.claim_type, c.loss_date, c.opened_at, c.estimated_loss,
         c.reopen_count, c.escalation_level, c.severity, c.possible_duplicate_of,
         p.effective_date, p.expiry_date, p.sum_insured, p.created_at as policy_created_at,
         (select count(*) from public.documents d where d.claim_id = c.id)::int as document_count,
         (select count(*) from public.documents d where d.claim_id = c.id and d.status = 'REJECTED')::int as rejected_documents,
         (select count(*) from public.claims x
           where x.customer_id = c.customer_id and x.id <> c.id
             and x.status not in ('DRAFT', 'WITHDRAWN') and x.opened_at < c.opened_at)::int as prior_claims,
         coalesce((select count(distinct ep2.entity_id)
                     from public.entity_premises ep
                     join public.entity_premises ep2 on ep2.premises_hash = ep.premises_hash
                    where ep.entity_id = c.customer_id), 1)::int as entities_at_premises
    from public.claims c
    left join public.policies p on p.id = c.policy_id
   where c.status not in ('DRAFT', 'WITHDRAWN')`

async function loadRows(db, extraWhere = '', params = []) {
  return db.query(`${TRAINING_SQL}${extraWhere}`, params)
}

async function authorityThresholds(db) {
  const rows = await db.query(
    `select distinct max_amount from public.authority_limits
      where max_amount is not null and (effective_to is null or effective_to > now())`,
  )
  return rows.map((r) => Number(r.max_amount))
}

/**
 * Trains a new version on everything in the book and makes it active.
 * Returns the stored model row plus the distribution it produced, so a
 * retrain that collapses (every claim scored identical) is visible.
 */
export async function trainClaimAnomalyModel(db, { trees = 100, seed = 42, actorId = null } = {}) {
  const [rows, thresholds] = await Promise.all([loadRows(db), authorityThresholds(db)])
  if (rows.length < MIN_TRAINING_ROWS) {
    const err = new Error(
      `Need at least ${MIN_TRAINING_ROWS} submitted claims to train; the book has ${rows.length}. ` +
        'Until then the rule-based signals carry triage on their own.',
    )
    err.code = 'INSUFFICIENT_TRAINING_DATA'
    err.rows = rows.length
    throw err
  }

  const stats = buildPopulationStats(rows, { authorityThresholds: thresholds })
  const vectors = rows.map((r) => toVector(r, stats))
  const forest = trainIsolationForest(vectors, { trees, seed })
  const scores = vectors.map((v) => anomalyScore(forest, v))
  const sorted = [...scores].sort((a, b) => a - b)
  const metrics = {
    rows: rows.length,
    min: Number(sorted[0].toFixed(5)),
    median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(5)),
    max: Number(sorted[sorted.length - 1].toFixed(5)),
    flaggedAboveElevated: scores.filter((s) => s >= 0.55).length,
  }

  return db.tx(async (t) => {
    const [{ next }] = await t.query(
      'select coalesce(max(version), 0) + 1 as next from public.ml_models where name = $1',
      [MODEL_NAME],
    )
    // Deactivate first: ml_models_one_active allows a single active row per name.
    await t.query('update public.ml_models set active = false where name = $1 and active', [MODEL_NAME])
    const [saved] = await t.query(
      `insert into public.ml_models (name, version, algorithm, payload, feature_names, trained_on, metrics, trained_by, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, true) returning id, version, trained_on, metrics`,
      [
        MODEL_NAME,
        next,
        ALGORITHM,
        JSON.stringify({ forest: serializeModel(forest), stats, medians: featureMedians(vectors) }),
        featureNames,
        rows.length,
        JSON.stringify(metrics),
        actorId,
      ],
    )
    return saved
  })
}

export async function loadActiveModel(db) {
  const [row] = await db.query(
    'select id, version, payload, feature_names, trained_on, metrics from public.ml_models where name = $1 and active',
    [MODEL_NAME],
  )
  if (!row) return null
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
  // A model trained on a different feature list cannot score today's vectors.
  // Silently scoring anyway would be wrong rather than merely stale.
  if (row.feature_names.join('|') !== featureNames.join('|')) {
    const err = new Error(`Model v${row.version} was trained on a different feature set. Retrain before scoring.`)
    err.code = 'MODEL_FEATURE_MISMATCH'
    throw err
  }
  return {
    id: row.id,
    version: row.version,
    trainedOn: row.trained_on,
    metrics: row.metrics,
    forest: deserializeModel(payload.forest),
    stats: payload.stats,
    medians: payload.medians,
  }
}

function scoreRow(model, row) {
  const vector = toVector(row, model.stats)
  const score = anomalyScore(model.forest, vector)
  return {
    claimId: row.claim_id,
    claimNumber: row.claim_number,
    score: Number(score.toFixed(5)),
    band: band(score),
    topFactors: explainScore(model.forest, vector, model.medians, featureNames),
  }
}

/** Scores one claim. This is the call a route or an intake hook would make. */
export async function scoreClaim(db, claimId) {
  const model = await loadActiveModel(db)
  if (!model) return null
  const [row] = await loadRows(db, ' and c.id = $1', [claimId])
  if (!row) return null
  const scored = scoreRow(model, row)
  await persistScores(db, model.id, [scored])
  return { ...scored, modelVersion: model.version }
}

/** Rescores the whole book. This is what the nightly job calls. */
export async function scoreAllClaims(db) {
  const model = await loadActiveModel(db)
  if (!model) return { scored: 0, modelVersion: null, results: [] }
  const rows = await loadRows(db)
  const results = rows.map((r) => scoreRow(model, r)).sort((a, b) => b.score - a.score)
  await persistScores(db, model.id, results)
  return { scored: results.length, modelVersion: model.version, results }
}

async function persistScores(db, modelId, results) {
  for (const r of results) {
    await db.query(
      `insert into public.claim_anomaly_scores (claim_id, model_id, score, band, top_factors, scored_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (claim_id) do update set
         model_id = excluded.model_id, score = excluded.score, band = excluded.band,
         top_factors = excluded.top_factors, scored_at = now()`,
      [r.claimId, modelId, r.score, r.band, JSON.stringify(r.topFactors)],
    )
  }
}
