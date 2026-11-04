/**
 * Isolation Forest (Liu, Ting & Zhou, 2008) in plain JavaScript.
 *
 * Why this algorithm: it is unsupervised, so it trains on claims as they are —
 * no confirmed-fraud labels, which we do not have yet. It isolates points by
 * random axis-aligned splits; anomalies sit in sparse regions and get isolated
 * in fewer splits, so a short average path length means "unusual".
 *
 * It learns the shape of OUR book of business. A claim is not anomalous in the
 * abstract — it is anomalous relative to the claims this company actually sees.
 *
 * What it is not: a fraud detector. It finds statistical outliers. Large
 * legitimate claims are outliers too. Output is a triage ordering for human
 * attention, never a finding.
 */

/** Deterministic PRNG so a retrain on unchanged data reproduces the model. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Average path length of an unsuccessful search in a binary search tree —
 * the normalisation constant from the paper. Without it, scores would depend
 * on the sample size and could not be compared between retrains.
 */
function averagePathLength(n) {
  if (n <= 1) return 0
  if (n === 2) return 1
  const EULER = 0.5772156649
  return 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n
}

function buildTree(rows, depth, maxDepth, rand) {
  if (depth >= maxDepth || rows.length <= 1) return { size: rows.length }

  // Only split on features that actually vary in this partition; a constant
  // column would produce an empty child and waste the level.
  const usable = []
  for (let f = 0; f < rows[0].length; f += 1) {
    let min = Infinity
    let max = -Infinity
    for (const r of rows) {
      if (r[f] < min) min = r[f]
      if (r[f] > max) max = r[f]
    }
    if (max > min) usable.push([f, min, max])
  }
  if (!usable.length) return { size: rows.length }

  const [feature, min, max] = usable[Math.floor(rand() * usable.length)]
  const threshold = min + rand() * (max - min)
  const left = []
  const right = []
  for (const r of rows) (r[feature] < threshold ? left : right).push(r)
  if (!left.length || !right.length) return { size: rows.length }

  return {
    feature,
    threshold,
    left: buildTree(left, depth + 1, maxDepth, rand),
    right: buildTree(right, depth + 1, maxDepth, rand),
  }
}

function pathLength(tree, point, depth = 0) {
  if (tree.size !== undefined) return depth + averagePathLength(tree.size)
  return pathLength(point[tree.feature] < tree.threshold ? tree.left : tree.right, point, depth + 1)
}

/**
 * @param {number[][]} data  one numeric row per claim
 * @param {{trees?: number, sampleSize?: number, seed?: number}} opts
 */
export function trainIsolationForest(data, { trees = 100, sampleSize = 256, seed = 42 } = {}) {
  if (!data.length) throw new Error('Isolation Forest needs at least one row to train on')
  const rand = mulberry32(seed)
  const n = Math.min(sampleSize, data.length)
  // Depth beyond log2(n) cannot isolate anything further; the paper caps here.
  const maxDepth = Math.ceil(Math.log2(Math.max(2, n)))
  const forest = []

  for (let i = 0; i < trees; i += 1) {
    const sample = []
    for (let j = 0; j < n; j += 1) sample.push(data[Math.floor(rand() * data.length)])
    forest.push(buildTree(sample, 0, maxDepth, rand))
  }

  return { trees: forest, normaliser: averagePathLength(n), featureCount: data[0].length, sampleSize: n }
}

/**
 * Anomaly score in [0, 1]. Above ~0.6 is unusual; near 0.5 is typical of the
 * training population; below 0.5 is very ordinary.
 */
export function anomalyScore(model, point) {
  if (point.length !== model.featureCount) {
    throw new Error(`Expected ${model.featureCount} features, received ${point.length}`)
  }
  let total = 0
  for (const tree of model.trees) total += pathLength(tree, point)
  return 2 ** (-(total / model.trees.length) / model.normaliser)
}

/**
 * Which features pushed this point towards isolation, by re-scoring with each
 * feature replaced by the population median. The largest score drop is the
 * feature most responsible.
 *
 * This is an attribution heuristic, not an exact Shapley value — it exists so
 * a reviewer is never shown a bare number with no reason attached.
 */
export function explainScore(model, point, medians, names) {
  const base = anomalyScore(model, point)
  const contributions = []
  for (let f = 0; f < point.length; f += 1) {
    const neutralised = [...point]
    neutralised[f] = medians[f]
    contributions.push({ feature: names?.[f] ?? `f${f}`, impact: Number((base - anomalyScore(model, neutralised)).toFixed(4)) })
  }
  return contributions.filter((c) => c.impact > 0).sort((a, b) => b.impact - a.impact).slice(0, 5)
}

export function serializeModel(model) {
  return JSON.stringify(model)
}

export function deserializeModel(json) {
  return typeof json === 'string' ? JSON.parse(json) : json
}
