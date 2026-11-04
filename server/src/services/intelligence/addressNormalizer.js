import { createHash } from 'node:crypto'

/**
 * Canonicalises an Indian postal address down to a BUILDING-level key.
 *
 * Why building level: shell entities registered at one co-working tower differ
 * only by suite number ("Suite 101" vs "Suite 204"). Hashing the whole address
 * makes them look unrelated, which is exactly what the arrangement relies on.
 * The unit is parsed out and kept beside the hash, not inside it.
 *
 * The same building is also written many ways — "5th Flr, Prestige Twr, M.G.
 * Rd, Bengaluru - 560 001" and "Prestige Towers, MG Road, Bangalore 560001".
 * Tokens are expanded, de-pluralised, de-duplicated and sorted, so word order
 * and spelling drift stop mattering.
 */

// Co-working and virtual-office brands. A match is not suspicious by itself —
// it only tells us an address collision at this building is expected, so the
// collision alone must not drive the score.
const WORKSPACE_PROVIDERS = [
  ['WEWORK', /\bwe\s?work\b/],
  ['REGUS', /\bregus\b/],
  ['AWFIS', /\bawfis\b/],
  ['91SPRINGBOARD', /\b91\s?springboard\b/],
  ['COWRKS', /\bcowrks\b/],
  ['INNOV8', /\binnov\s?8\b/],
  ['SMARTWORKS', /\bsmart\s?works\b/],
  ['IKEVA', /\bikeva\b/],
  ['BHIVE', /\bb\s?hive\b/],
  ['TABLESPACE', /\btable\s?space\b/],
  ['GENERIC', /\b(?:co[-\s]?working|coworking|virtual\s+office|shared\s+office|business\s+(?:centre|center)|serviced\s+office|managed\s+office)\b/],
]

const ABBREVIATIONS = new Map(Object.entries({
  rd: 'road', st: 'street', ave: 'avenue', avn: 'avenue', blvd: 'boulevard', ln: 'lane',
  twr: 'tower', bldg: 'building', bldgs: 'building', blg: 'building', hse: 'house',
  ctr: 'centre', cntr: 'centre', center: 'centre', cmplx: 'complex', aptmt: 'apartment',
  jn: 'junction', jnc: 'junction', ext: 'extension', ph: 'phase', sec: 'sector',
  mkt: 'market', ngr: 'nagar', indl: 'industrial', estt: 'estate', crossrd: 'crossroad',
}))

// Renamed cities must collapse, or one entity "in Bengaluru" and another
// "in Bangalore" never collide.
const CITY_ALIASES = new Map(Object.entries({
  bengaluru: 'bangalore', bombay: 'mumbai', calcutta: 'kolkata', madras: 'chennai',
  gurgaon: 'gurugram', poona: 'pune', baroda: 'vadodara', mysore: 'mysuru',
  trivandrum: 'thiruvananthapuram', pondicherry: 'puducherry', cochin: 'kochi',
}))

// Corporate suffixes and filler. These travel with the *entity*, not the
// building, so leaving them in would split two shells at one address apart.
const NOISE = new Set([
  'india', 'bharat', 'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'incorporated',
  'co', 'company', 'corp', 'corporation', 'regd', 'registered', 'office', 'address', 'addr',
  'the', 'at', 'near', 'nr', 'opp', 'opposite', 'behind', 'beside', 'above', 'below',
  'landmark', 'po', 'pin', 'pincode', 'dist', 'district', 'state', 'tal', 'taluk',
])

const UNIT_PATTERNS = [
  /\b(?:suite|ste|unit|office|cabin|desk|seat|shop|flat|room|apt|apartment)\s*\.?\s*#?\s*([0-9]+\s*[a-z]?|[a-z]\s*-?\s*[0-9]+)\b/g,
  /\b(?:no|number)\s*\.?\s*([0-9]+\s*[a-z]?)\b/g,
  /#\s*([0-9]+\s*[a-z]?)\b/g,
  /\b((?:\d+(?:st|nd|rd|th)?|ground|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|basement|mezzanine|lower|upper)\s*(?:floor|flr|fl))\b/g,
]

const stripDiacritics = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '')

/** Trailing plural only, and only on words long enough that it is not part of the stem. */
const singularise = (t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)

/** "m g road" and "mg road" are the same road: fuse runs of single letters. */
function mergeInitials(parts) {
  const out = []
  let run = []
  for (const p of parts) {
    if (p.length === 1 && /[a-z]/.test(p)) { run.push(p); continue }
    if (run.length) { out.push(run.join('')); run = [] }
    out.push(p)
  }
  if (run.length) out.push(run.join(''))
  return out
}

export function detectWorkspaceProvider(raw) {
  const s = stripDiacritics(String(raw ?? '')).toLowerCase()
  for (const [name, re] of WORKSPACE_PROVIDERS) if (re.test(s)) return name
  return null
}

/**
 * @returns {{premisesHash: string|null, buildingKey: string, unitLabel: string|null,
 *            pincode: string|null, city: string|null, workspaceProvider: string|null,
 *            isSharedWorkspace: boolean, tokens: string[]}}
 */
export function normalizeAddress(raw, { entityName } = {}) {
  const original = String(raw ?? '').trim()
  const workspaceProvider = detectWorkspaceProvider(original)
  const empty = {
    premisesHash: null, buildingKey: '', unitLabel: null, pincode: null, city: null,
    workspaceProvider, isSharedWorkspace: Boolean(workspaceProvider), tokens: [],
  }
  if (!original) return empty

  let s = stripDiacritics(original).toLowerCase()

  // Pincode first: "560 001" and "560001" are the same place.
  let pincode = null
  const pin = /\b([1-9]\d{2})\s?(\d{3})\b/.exec(s)
  if (pin) {
    pincode = `${pin[1]}${pin[2]}`
    s = s.replace(pin[0], ' ')
  }

  // Pull the unit out before tokenising — it must not reach the hash.
  const units = []
  for (const re of UNIT_PATTERNS) {
    s = s.replace(re, (match) => {
      units.push(match.replace(/\s+/g, ' ').trim())
      return ' '
    })
  }

  // The entity's own name is often written into its address line. It differs
  // between two shells at one building, so it must not reach the hash.
  // (If a company is named after its building the building name is stripped
  // too — a near-miss premisesSimilarity still surfaces that case.)
  const entityTokens = new Set(
    stripDiacritics(String(entityName ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
      .filter(Boolean).map((t) => singularise(t)),
  )

  const tokens = []
  const seen = new Set()
  for (const rawToken of mergeInitials(s.replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean))) {
    let t = ABBREVIATIONS.get(rawToken) ?? rawToken
    t = CITY_ALIASES.get(t) ?? t
    t = singularise(t)
    // Single characters left over from punctuation carry no building identity.
    if (t.length < 2 || NOISE.has(t) || entityTokens.has(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    tokens.push(t)
  }

  const sorted = [...tokens].sort()
  const buildingKey = `${pincode ?? '-'}|${sorted.join(' ')}`
  // Too little signal to assert two addresses are the same building.
  const hashable = sorted.length >= 2 && (pincode || sorted.length >= 3)

  return {
    premisesHash: hashable ? createHash('sha256').update(buildingKey).digest('hex') : null,
    buildingKey,
    unitLabel: units.length ? units.join(', ') : null,
    pincode,
    city: sorted.find((t) => CITY_ALIASES.has(t) || [...CITY_ALIASES.values()].includes(t)) ?? null,
    workspaceProvider,
    isSharedWorkspace: Boolean(workspaceProvider),
    tokens: sorted,
  }
}

/**
 * Jaccard overlap of building tokens, for near-misses the exact hash cannot
 * catch (a missing pincode, a dropped building name). Used to surface
 * "probably the same building" for a human to confirm — never to auto-link.
 */
export function premisesSimilarity(a, b) {
  const x = new Set(a?.tokens ?? [])
  const y = new Set(b?.tokens ?? [])
  if (!x.size || !y.size) return 0
  let shared = 0
  for (const t of x) if (y.has(t)) shared += 1
  return shared / (x.size + y.size - shared)
}
