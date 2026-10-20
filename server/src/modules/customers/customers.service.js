import { ACTIVE_STATUSES } from '../../../../shared/constants.js'
import { notFound } from '../../utils/errors.js'
import { escapeLike } from '../../db/queryBuilder.js'
import { maskAccount } from '../../utils/format.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { requirePermission } from '../../services/access.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { can } from '../../../../shared/permissions.js'

// Internal evidence is never part of a customer record.
const INTERNAL_CATEGORIES = ['INVESTIGATION_EVIDENCE', 'COMPLIANCE_EVIDENCE']
const EXPORT_LIMIT = 5000

const SORT_COLUMNS = {
  name: 'lower(x.full_name)',
  created_at: 'x.created_at',
  last_claim_at: 'x.last_claim_at',
  claim_count: 'x.claim_count',
  last_activity_at: 'x.last_activity_at',
}

/**
 * One row per customer (a profile holding the CUSTOMER role) with aggregates.
 * Draft claims are excluded: they are not part of the official record yet.
 * possible_duplicate flags another customer with the same phone digits or the
 * same normalized name; email is already unique, so this is a review hint only.
 */
const CUSTOMER_ROWS = `
  with customers as (
    select p.id, p.full_name, p.email, p.phone, p.is_active, p.created_at,
           regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') as phone_digits,
           lower(btrim(p.full_name)) as name_key
    from public.profiles p
    where exists (select 1 from public.user_roles ur where ur.user_id = p.id and ur.role_code = 'CUSTOMER')
  )
  select c.id, c.full_name, c.email, c.phone, c.is_active, c.created_at, c.phone_digits,
    (select count(*)::int from public.policies po where po.holder_id = c.id) as policy_count,
    (select string_agg(po.policy_number, ', ' order by po.policy_number) from public.policies po where po.holder_id = c.id) as policy_numbers,
    (select count(*)::int from public.claims cl where cl.customer_id = c.id and cl.status <> 'DRAFT') as claim_count,
    (select count(*)::int from public.claims cl where cl.customer_id = c.id and cl.status = any($1::text[])) as open_claim_count,
    (select max(cl.submitted_at) from public.claims cl where cl.customer_id = c.id) as last_claim_at,
    greatest(c.created_at,
      (select max(cl.updated_at) from public.claims cl where cl.customer_id = c.id and cl.status <> 'DRAFT'),
      (select max(po.updated_at) from public.policies po where po.holder_id = c.id)) as last_activity_at,
    exists (
      select 1 from customers d where d.id <> c.id and (
        (length(c.phone_digits) >= 7 and d.phone_digits = c.phone_digits)
        or (c.name_key <> '' and d.name_key = c.name_key))
    ) as possible_duplicate
  from customers c`

function buildFilters(query, params) {
  const where = []
  const add = (value) => {
    params.push(value)
    return `$${params.length}`
  }
  if (query.search) {
    const term = add(`%${escapeLike(query.search)}%`)
    const digits = query.search.replace(/[^0-9]/g, '')
    const parts = [
      `x.full_name ilike ${term}`,
      `x.email ilike ${term}`,
      `x.id::text ilike ${term}`,
      `coalesce(x.policy_numbers, '') ilike ${term}`,
    ]
    if (digits.length >= 3) parts.push(`x.phone_digits like ${add(`%${digits}%`)}`)
    where.push(`(${parts.join(' or ')})`)
  }
  if (query.policyType) {
    where.push(`exists (select 1 from public.policies po where po.holder_id = x.id and po.policy_type = ${add(query.policyType)})`)
  }
  if (query.policyStatus) {
    where.push(`exists (select 1 from public.policies po where po.holder_id = x.id and po.status = ${add(query.policyStatus)})`)
  }
  if (query.hasOpenClaims === 'true') where.push('x.open_claim_count > 0')
  if (query.hasOpenClaims === 'false') where.push('x.open_claim_count = 0')
  if (query.status === 'active') where.push('x.is_active')
  if (query.status === 'inactive') where.push('not x.is_active')
  if (query.possibleDuplicate === 'true') where.push('x.possible_duplicate')
  return where.length ? `where ${where.join(' and ')}` : ''
}

function retainUntil(lastActivityAt, years) {
  if (!lastActivityAt) return null
  const d = new Date(lastActivityAt)
  d.setUTCFullYear(d.getUTCFullYear() + years)
  return d.toISOString()
}

function presentRow(row, years) {
  const { phone_digits: _digits, ...rest } = row
  return { ...rest, retain_until: retainUntil(row.last_activity_at, years) }
}

async function queryCustomers(t, query, { limit, offset }) {
  const params = [ACTIVE_STATUSES]
  const filters = buildFilters(query, params)
  const sort = SORT_COLUMNS[query.sort] || SORT_COLUMNS.name
  const dir = query.direction === 'desc' ? 'desc' : 'asc'
  const base = `select * from (${CUSTOMER_ROWS}) x ${filters}`
  const [rows, [{ total }]] = await Promise.all([
    t.query(`${base} order by ${sort} ${dir} nulls last, x.id limit ${Number(limit)} offset ${Number(offset)}`, params),
    t.query(`select count(*)::int as total from (${base}) counted`, params),
  ])
  return { rows, total }
}

export async function listCustomers(ctx, query) {
  requirePermission(ctx.actor, 'customers.view')
  const { rows, total } = await queryCustomers(ctx.db, query, toOffset(query))
  return {
    items: rows.map((r) => presentRow(r, ctx.config.CUSTOMER_RECORD_RETENTION_YEARS)),
    meta: { ...pageMeta(query, total), retentionYears: ctx.config.CUSTOMER_RECORD_RETENTION_YEARS },
  }
}

async function loadCustomer(t, customerId) {
  const [row] = await t.query(`select * from (${CUSTOMER_ROWS}) x where x.id = $2`, [ACTIVE_STATUSES, customerId])
  if (!row) throw notFound('Customer not found')
  return row
}

export async function getCustomer(ctx, customerId) {
  requirePermission(ctx.actor, 'customers.view')
  const years = ctx.config.CUSTOMER_RECORD_RETENTION_YEARS
  const row = await loadCustomer(ctx.db, customerId)
  const showDocuments = can(ctx.actor.roles, 'customers.viewDocuments')

  const [policies, claims, documents, duplicates] = await Promise.all([
    ctx.db.query(
      `select id, policy_number, policy_type, insured_name, status, effective_from, effective_to, sum_insured,
              deductible, insured_asset, payout_bank_name, payout_account_number, created_at
       from public.policies where holder_id = $1 order by effective_from desc`,
      [customerId],
    ),
    ctx.db.query(
      `select c.id, c.claim_number, c.status, c.claim_type, c.priority, c.incident_at, c.incident_category,
              c.estimated_loss, c.submitted_at, c.closed_at, c.updated_at, p.policy_number,
              (select count(*)::int from public.documents d where d.claim_id = c.id
                 and d.category <> all($2::text[]) and d.status <> 'SUPERSEDED') as document_count
       from public.claims c left join public.policies p on p.id = c.policy_id
       where c.customer_id = $1 and c.status <> 'DRAFT'
       order by c.submitted_at desc nulls last`,
      [customerId, INTERNAL_CATEGORIES],
    ),
    showDocuments
      ? ctx.db.query(
          `select d.id, d.claim_id, c.claim_number, d.category, d.file_name, d.mime_type, d.size_bytes, d.status,
                  d.version_no, d.uploaded_at
           from public.documents d join public.claims c on c.id = d.claim_id
           where c.customer_id = $1 and c.status <> 'DRAFT' and d.category <> all($2::text[])
           order by d.uploaded_at desc`,
          [customerId, INTERNAL_CATEGORIES],
        )
      : Promise.resolve(null),
    ctx.db.query(
      `select p.id, p.full_name, p.email,
              case when regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') = $2 and length($2) >= 7 then 'Same phone number'
                   else 'Same name' end as reason
       from public.profiles p
       where p.id <> $1
         and exists (select 1 from public.user_roles ur where ur.user_id = p.id and ur.role_code = 'CUSTOMER')
         and ((length($2) >= 7 and regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') = $2)
              or (btrim($3) <> '' and lower(btrim(p.full_name)) = lower(btrim($3))))
       order by p.full_name`,
      [customerId, row.phone_digits, row.full_name],
    ),
  ])

  await recordAudit(ctx.db, ctx.actor, {
    action: 'CUSTOMER_RECORD_VIEWED',
    entityType: 'profile',
    entityId: customerId,
  })

  return {
    customer: presentRow(row, years),
    policies: policies.map(({ payout_account_number: account, ...p }) => ({ ...p, payout_account_masked: maskAccount(account) })),
    claims,
    documents,
    possibleDuplicates: duplicates,
    retention: {
      years,
      retainUntil: retainUntil(row.last_activity_at, years),
      policy: `Customer records are kept for ${years} years after the last activity on the customer, their policies or claims. They cannot be deleted through this application.`,
    },
  }
}

const CSV_COLUMNS = [
  ['id', 'Customer ID'],
  ['full_name', 'Name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['is_active', 'Active'],
  ['policy_numbers', 'Policy numbers'],
  ['policy_count', 'Policies'],
  ['claim_count', 'Claims'],
  ['open_claim_count', 'Open claims'],
  ['last_claim_at', 'Last claim submitted'],
  ['last_activity_at', 'Last activity'],
  ['retain_until', 'Retain until'],
  ['possible_duplicate', 'Possible duplicate'],
  ['created_at', 'Customer since'],
]

function csvCell(value) {
  if (value === null || value === undefined) return ''
  let text = value instanceof Date ? value.toISOString() : String(value)
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export async function exportCustomers(ctx, query) {
  requirePermission(ctx.actor, 'customers.export')
  const years = ctx.config.CUSTOMER_RECORD_RETENTION_YEARS
  const { rows, total } = await queryCustomers(ctx.db, query, { limit: EXPORT_LIMIT, offset: 0 })
  const lines = [CSV_COLUMNS.map(([, header]) => header).join(',')]
  for (const row of rows.map((r) => presentRow(r, years))) {
    lines.push(CSV_COLUMNS.map(([key]) => csvCell(row[key])).join(','))
  }
  const { page: _p, pageSize: _s, ...filters } = query
  await recordAudit(ctx.db, ctx.actor, {
    action: 'CUSTOMER_RECORDS_EXPORTED',
    entityType: 'profile',
    metadata: { filters, rows: rows.length, totalMatching: total, truncated: total > rows.length },
  })
  return { csv: `${lines.join('\n')}\n`, rows: rows.length, truncated: total > rows.length }
}

export async function downloadCustomerDocument(ctx, customerId, documentId) {
  requirePermission(ctx.actor, 'customers.viewDocuments')
  const [doc] = await ctx.db.query(
    `select d.* from public.documents d join public.claims c on c.id = d.claim_id
     where d.id = $1 and c.customer_id = $2 and c.status <> 'DRAFT' and d.category <> all($3::text[])`,
    [documentId, customerId, INTERNAL_CATEGORIES],
  )
  if (!doc) throw notFound('Document not found')
  const buffer = await ctx.storage.get(doc.storage_path)
  await recordAudit(ctx.db, ctx.actor, {
    action: 'DOCUMENT_DOWNLOADED',
    entityType: 'document',
    entityId: doc.id,
    claimId: doc.claim_id,
    metadata: { fileName: doc.file_name, via: 'customer_records' },
  })
  return { doc, buffer }
}
