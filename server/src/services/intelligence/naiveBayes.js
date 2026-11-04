/**
 * Multinomial Naive Bayes over document text, trained on our own `doc_type`
 * labels.
 *
 * Unlike the anomaly model this is genuinely SUPERVISED: every row in
 * `documents` already carries the class a reviewer assigned, so the labels
 * exist today and cost nothing to collect.
 *
 * Naive Bayes rather than anything heavier because the training set is small.
 * With a few dozen documents per class a high-variance model memorises; NB's
 * independence assumption is wrong but it is wrong in a stable way, which is
 * the right trade at this sample size.
 *
 * Scores are log-probabilities summed over tokens, so underflow cannot occur.
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'are', 'was', 'were', 'has', 'have', 'had',
  'not', 'all', 'any', 'been', 'will', 'shall', 'may', 'his', 'her', 'its', 'their', 'our', 'you',
  'date', 'name', 'no', 'nos', 'number', 'rs', 'inr', 'total', 'page', 'per', 'as', 'at', 'by',
  'in', 'is', 'it', 'of', 'on', 'or', 'to', 'be', 'an', 'a',
])

/**
 * Digits are collapsed to a single token: the *presence* of an amount or a
 * reference number is a class signal, the specific value never is. Without
 * this, every invoice number becomes a unique feature and the model memorises
 * individual documents instead of learning the class.
 */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? '#num' : t))
    .filter((t) => t.length >= 2 && t.length <= 24 && !STOPWORDS.has(t))
}

/** @param {{text: string, label: string}[]} samples */
export function trainNaiveBayes(samples, { minTokenFrequency = 2 } = {}) {
  if (!samples.length) throw new Error('Naive Bayes needs at least one labelled document')

  const tokenised = samples.map((s) => ({ label: s.label, tokens: tokenize(s.text) }))

  // Tokens seen once across the whole corpus are noise at this sample size.
  const corpusCounts = new Map()
  for (const s of tokenised) for (const t of s.tokens) corpusCounts.set(t, (corpusCounts.get(t) ?? 0) + 1)
  const vocabulary = [...corpusCounts.entries()].filter(([, n]) => n >= minTokenFrequency).map(([t]) => t)
  const vocabSet = new Set(vocabulary)

  const classCounts = new Map()
  const tokenCounts = new Map()
  const classTotals = new Map()
  for (const { label, tokens } of tokenised) {
    classCounts.set(label, (classCounts.get(label) ?? 0) + 1)
    if (!tokenCounts.has(label)) tokenCounts.set(label, new Map())
    const counts = tokenCounts.get(label)
    let total = classTotals.get(label) ?? 0
    for (const t of tokens) {
      if (!vocabSet.has(t)) continue
      counts.set(t, (counts.get(t) ?? 0) + 1)
      total += 1
    }
    classTotals.set(label, total)
  }

  return {
    classes: [...classCounts.keys()],
    priors: Object.fromEntries([...classCounts].map(([c, n]) => [c, Math.log(n / samples.length)])),
    counts: Object.fromEntries([...tokenCounts].map(([c, m]) => [c, Object.fromEntries(m)])),
    totals: Object.fromEntries(classTotals),
    vocabulary,
    vocabSize: vocabulary.length,
    trainedOn: samples.length,
  }
}

/** @returns {{label: string|null, confidence: number, scores: object[]}} */
export function classify(model, text) {
  const tokens = tokenize(text).filter((t) => model.vocabulary.includes(t))
  if (!tokens.length) return { label: null, confidence: 0, scores: [] }

  const logScores = model.classes.map((cls) => {
    const counts = model.counts[cls] ?? {}
    const total = model.totals[cls] ?? 0
    let score = model.priors[cls]
    for (const t of tokens) {
      // Laplace smoothing: an unseen token must not zero the whole class.
      score += Math.log(((counts[t] ?? 0) + 1) / (total + model.vocabSize))
    }
    return { label: cls, logScore: score }
  })

  // Softmax in log space, shifted by the max so exp() cannot overflow.
  const max = Math.max(...logScores.map((s) => s.logScore))
  const exped = logScores.map((s) => ({ label: s.label, weight: Math.exp(s.logScore - max) }))
  const sum = exped.reduce((acc, s) => acc + s.weight, 0)
  const scores = exped
    .map((s) => ({ label: s.label, probability: Number((s.weight / sum).toFixed(4)) }))
    .sort((a, b) => b.probability - a.probability)

  return { label: scores[0].label, confidence: scores[0].probability, scores }
}

/**
 * Stratified k-fold cross-validation. This exists so the model's accuracy is
 * measured rather than asserted — on a small corpus the honest number is often
 * disappointing, and that is exactly what a reviewer needs to know before
 * trusting a suggestion.
 */
export function crossValidate(samples, { folds = 5, minTokenFrequency = 2 } = {}) {
  const byLabel = new Map()
  for (const s of samples) {
    if (!byLabel.has(s.label)) byLabel.set(s.label, [])
    byLabel.get(s.label).push(s)
  }
  // Stratify: each fold keeps the class mix of the whole corpus.
  const assigned = samples.map(() => 0)
  let cursor = 0
  const order = []
  for (const group of byLabel.values()) {
    for (const s of group) {
      order.push(s)
      assigned[order.length - 1] = cursor % folds
      cursor += 1
    }
  }

  let correct = 0
  let scored = 0
  const confusion = {}
  for (let f = 0; f < folds; f += 1) {
    const train = order.filter((_, i) => assigned[i] !== f)
    const test = order.filter((_, i) => assigned[i] === f)
    if (!train.length || !test.length) continue
    const model = trainNaiveBayes(train, { minTokenFrequency })
    for (const sample of test) {
      const { label } = classify(model, sample.text)
      if (label === null) continue
      scored += 1
      if (label === sample.label) correct += 1
      confusion[sample.label] ??= {}
      confusion[sample.label][label] = (confusion[sample.label][label] ?? 0) + 1
    }
  }
  return {
    accuracy: scored ? Number((correct / scored).toFixed(4)) : 0,
    scored,
    skipped: samples.length - scored,
    confusion,
  }
}
