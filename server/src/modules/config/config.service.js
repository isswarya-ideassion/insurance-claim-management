import { z } from 'zod'
import { POLICY_TYPES, DOCUMENT_TYPES } from '../../../../shared/constants.js'
import { businessRule, forbidden, notFound, validationError } from '../../utils/errors.js'
import { requirePermission } from '../../services/access.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { CONFIG_KEYS } from '../../services/config.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

const hours = z.number().int().positive().max(24 * 365)

/** Shape of each configuration value; a proposal must match before anyone can approve it. */
const VALUE_SCHEMAS = {
  required_artifacts: z.record(z.enum(POLICY_TYPES), z.array(z.enum(DOCUMENT_TYPES)).max(20)),
  sla_hours: z.record(z.string(), hours),
  severity_thresholds: z
    .object({ MEDIUM: z.number().positive(), HIGH: z.number().positive(), CATASTROPHIC: z.number().positive() })
    .refine((v) => v.MEDIUM < v.HIGH && v.HIGH < v.CATASTROPHIC, 'Thresholds must increase from MEDIUM to CATASTROPHIC'),
  fraud_review_threshold: z.number().int().min(0).max(100),
  unclaimed_task_escalation_hours: hours,
}

export async function listSegmentConfig(ctx) {
  requirePermission(ctx.actor, 'config.view')
  const rows = await ctx.db.findMany('segment_config', {
    where: { status: { in: ['ACTIVE', 'PROPOSED'] } },
    orderBy: [['segment', 'asc'], ['config_key', 'asc'], ['version', 'desc']],
  })
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.proposed_by, r.approved_by]))
  return rows.map((r) => ({ ...r, proposed_by_name: nameOf(names, r.proposed_by) || 'System', approved_by_name: nameOf(names, r.approved_by) }))
}

export async function proposeSegmentConfig(ctx, { segment, configKey, configValue, notes }) {
  requirePermission(ctx.actor, 'config.propose')
  if (!CONFIG_KEYS.includes(configKey)) throw validationError(`Unknown configuration key ${configKey}`)
  const parsed = VALUE_SCHEMAS[configKey].safeParse(configValue)
  if (!parsed.success) {
    throw validationError('The configuration value is not valid', parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })))
  }
  return ctx.db.tx(async (t) => {
    const [{ version }] = await t.query(
      'select coalesce(max(version), 0) + 1 as version from public.segment_config where segment = $1 and config_key = $2',
      [segment, configKey],
    )
    const row = await t.insert('segment_config', {
      segment,
      config_key: configKey,
      config_value: parsed.data,
      version,
      status: 'PROPOSED',
      notes: notes || null,
      proposed_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, { action: 'CONFIG_PROPOSED', entityType: 'segment_config', entityId: row.id, after: row })
    return row
  })
}

/** A second person approves; the active version is retired and the proposal takes effect now. */
export async function decideSegmentConfig(ctx, id, { decision, notes }) {
  requirePermission(ctx.actor, 'config.approve')
  return ctx.db.tx(async (t) => {
    const row = await t.findOne('segment_config', { id }, { forUpdate: true })
    if (!row) throw notFound('Configuration proposal not found')
    if (row.status !== 'PROPOSED') throw businessRule('ALREADY_DECIDED', 'This proposal has already been decided')
    if (row.proposed_by === ctx.actor.id) throw forbidden('A different person must approve your proposal', 'SELF_APPROVAL_FORBIDDEN')
    const now = new Date()
    if (decision === 'REJECTED') {
      const rejected = await t.updateById('segment_config', id, { status: 'REJECTED', approved_by: ctx.actor.id, approved_at: now, notes: notes || row.notes })
      await recordAudit(t, ctx.actor, { action: 'CONFIG_REJECTED', entityType: 'segment_config', entityId: id, before: row, after: rejected })
      return rejected
    }
    await t.update('segment_config', { segment: row.segment, config_key: row.config_key, status: 'ACTIVE' }, { status: 'RETIRED', effective_to: now })
    const active = await t.updateById('segment_config', id, { status: 'ACTIVE', approved_by: ctx.actor.id, approved_at: now, effective_from: now })
    await recordAudit(t, ctx.actor, { action: 'CONFIG_APPROVED', entityType: 'segment_config', entityId: id, before: row, after: active })
    return active
  })
}

export async function listAuthorityLimits(ctx) {
  requirePermission(ctx.actor, 'config.view')
  return ctx.db.findMany('authority_limits', { where: { effective_to: null }, orderBy: [['limit_type', 'asc'], ['segment', 'asc'], ['max_amount', 'asc']] })
}

export async function listFraudReasonCodes(ctx) {
  requirePermission(ctx.actor, 'config.view')
  return ctx.db.findMany('fraud_reason_codes', { orderBy: [['weight', 'desc']] })
}
