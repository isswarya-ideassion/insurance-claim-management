import { createHash, randomUUID } from 'node:crypto'
import { fileTypeFromBuffer } from 'file-type'
import {
  ROLES,
  ALLOWED_UPLOAD_MIME_TYPES,
  ALLOWED_UPLOAD_EXTENSIONS,
  ACTIVE_STATUSES,
  humanize,
} from '../../../../shared/constants.js'
import { AppError, businessRule, forbidden, notFound, validationError } from '../../utils/errors.js'
import { sanitizeFileName, hoursFromNow } from '../../utils/format.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import {
  claimScope,
  loadAccessibleClaim,
  isCustomerView,
  requirePermission,
  requireNotOwnClaim,
  requireStaffView,
  requireTab,
} from '../../services/access.service.js'
import { lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, claimLink } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

const INTERNAL_CATEGORIES = ['INVESTIGATION_EVIDENCE', 'COMPLIANCE_EVIDENCE']
const CUSTOMER_UPLOAD_STATUSES = ['DRAFT', 'SUBMITTED', 'POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW', 'INVESTIGATION', 'REOPENED']

function presentDocument(doc, names = {}, customer = false) {
  const base = {
    id: doc.id,
    claim_id: doc.claim_id,
    document_group_id: doc.document_group_id,
    version_no: doc.version_no,
    category: doc.category,
    file_name: doc.file_name,
    mime_type: doc.mime_type,
    size_bytes: doc.size_bytes,
    status: doc.status,
    uploaded_at: doc.uploaded_at,
    reviewed_at: doc.reviewed_at,
    rejection_reason: doc.rejection_reason,
    information_request_id: doc.information_request_id,
  }
  if (customer) return base
  return {
    ...base,
    checksum_sha256: doc.checksum_sha256,
    uploaded_by: doc.uploaded_by,
    uploaded_by_name: nameOf(names, doc.uploaded_by),
    reviewer_id: doc.reviewer_id,
    reviewer_name: nameOf(names, doc.reviewer_id),
    reviewed_by: doc.reviewed_by,
    reviewed_by_name: nameOf(names, doc.reviewed_by),
    review_comment: doc.review_comment,
    review_assigned_at: doc.review_assigned_at,
  }
}

export async function listClaimDocuments(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  const customer = isCustomerView(ctx.actor, claim)
  if (!customer) requireTab(ctx.actor, claim, 'documents')
  const where = { claim_id: claimId }
  if (customer) where.category = { nin: INTERNAL_CATEGORIES }
  const docs = await ctx.db.findMany('documents', { where, orderBy: [['uploaded_at', 'desc']] })
  const names = customer ? {} : await profileMap(ctx.db, docs.flatMap((d) => [d.uploaded_by, d.reviewer_id, d.reviewed_by]))
  return docs.map((d) => presentDocument(d, names, customer))
}

async function sniffFile(file) {
  if (!file) throw validationError('Attach a file to upload', [{ field: 'file', message: 'File is required' }])
  const ext = (file.originalname.split('.').pop() || '').toLowerCase()
  if (!ALLOWED_UPLOAD_EXTENSIONS.includes(ext)) {
    throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'Only PDF, JPEG, PNG and WebP files are accepted')
  }
  const detected = await fileTypeFromBuffer(file.buffer)
  if (!detected || !ALLOWED_UPLOAD_MIME_TYPES.includes(detected.mime)) {
    throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'File content does not match an accepted type (PDF, JPEG, PNG, WebP)')
  }
  const extMime = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext]
  if (extMime !== detected.mime) {
    throw new AppError(415, 'FILE_TYPE_MISMATCH', `File extension .${ext} does not match its content (${detected.mime})`)
  }
  return { mime: detected.mime, ext: detected.ext }
}

export async function uploadDocument(ctx, claimId, file, fields) {
  requirePermission(ctx.actor, 'documents.upload')
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  const customer = isCustomerView(ctx.actor, claim)
  const effectiveStatus = claim.status === 'ON_HOLD' ? claim.hold_from_status : claim.status

  if (customer) {
    if (!CUSTOMER_UPLOAD_STATUSES.includes(effectiveStatus)) {
      throw businessRule('UPLOAD_NOT_ALLOWED', 'Documents can no longer be added to this claim')
    }
    if (INTERNAL_CATEGORIES.includes(fields.category)) throw forbidden('This document category is reserved for staff')
  } else {
    requireTab(ctx.actor, claim, 'documents')
    requireNotOwnClaim(ctx.actor, claim)
    if (![...ACTIVE_STATUSES, 'ON_HOLD'].includes(claim.status)) {
      throw businessRule('UPLOAD_NOT_ALLOWED', 'Documents cannot be added to a claim in this status')
    }
  }

  const { mime, ext } = await sniffFile(file)
  const documentId = randomUUID()
  const storagePath = `claims/${claimId}/${documentId}.${ext}`
  const checksum = createHash('sha256').update(file.buffer).digest('hex')

  // The object is stored before the metadata row; an orphaned object (if the
  // transaction later fails) is unreachable because downloads resolve via metadata.
  await ctx.storage.put(storagePath, file.buffer, mime)

  return ctx.db.tx(async (t) => {
    const locked = await lockClaim(t, claimId)
    let groupId = randomUUID()
    let versionNo = 1
    if (fields.replacesDocumentId) {
      const previous = await t.findOne('documents', { id: fields.replacesDocumentId, claim_id: claimId }, { forUpdate: true })
      if (!previous) throw notFound('Document to replace was not found on this claim')
      if (previous.status === 'SUPERSEDED') throw businessRule('ALREADY_SUPERSEDED', 'Only the latest version of a document can be replaced')
      groupId = previous.document_group_id
      versionNo = previous.version_no + 1
      await t.updateById('documents', previous.id, { status: 'SUPERSEDED' })
    }

    let request = null
    if (fields.informationRequestId) {
      request = await t.findOne('information_requests', { id: fields.informationRequestId, claim_id: claimId })
      if (!request) throw notFound('Information request not found on this claim')
    } else {
      request = await t.findOne(
        'information_requests',
        { claim_id: claimId, status: 'OPEN', request_type: 'DOCUMENT', document_category: fields.category },
        { orderBy: [['created_at', 'asc']] },
      )
    }

    const doc = await t.insert('documents', {
      id: documentId,
      claim_id: claimId,
      document_group_id: groupId,
      version_no: versionNo,
      category: fields.category,
      file_name: sanitizeFileName(file.originalname),
      storage_path: storagePath,
      mime_type: mime,
      size_bytes: file.size,
      checksum_sha256: checksum,
      uploaded_by: ctx.actor.id,
      information_request_id: request?.id || null,
      reviewer_id: locked.assigned_reviewer_id || null,
      review_assigned_at: locked.assigned_reviewer_id ? new Date() : null,
    })

    if (request && request.status === 'OPEN') {
      await t.updateById('information_requests', request.id, {
        status: 'RESPONDED',
        responded_by: ctx.actor.id,
        responded_at: new Date(),
        response_text: `Uploaded ${doc.file_name}`,
      })
    }

    await recordAudit(t, ctx.actor, {
      action: 'DOCUMENT_UPLOADED',
      entityType: 'document',
      entityId: doc.id,
      claimId,
      after: { ...doc, storage_path: undefined },
      metadata: { category: doc.category, version: versionNo, sizeBytes: file.size },
    })

    if (customer && locked.assigned_reviewer_id) {
      await notify(ctx, t, {
        recipientIds: [locked.assigned_reviewer_id],
        claimId,
        type: 'TASK_ASSIGNED',
        title: `New document on ${locked.claim_number || 'a claim'}`,
        message: `${humanize(doc.category)} uploaded and awaiting review.`,
        link: claimLink(locked, false),
        email: false,
      })
    }

    let claimAfter = locked
    if (customer && locked.status === 'DOCUMENTS_REQUIRED') {
      const stillOpen = await t.count('information_requests', { claim_id: claimId, status: 'OPEN', request_type: 'DOCUMENT' })
      if (stillOpen === 0) {
        claimAfter = await transitionClaim(ctx, t, locked, 'DOCUMENT_REVIEW', { reason: 'Requested documents provided by claimant' })
      }
    }
    return { document: presentDocument(doc, {}, customer), claimStatus: claimAfter.status }
  })
}

export async function downloadDocument(ctx, documentId) {
  const doc = await ctx.db.findById('documents', documentId)
  if (!doc) throw notFound('Document not found')
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, doc.claim_id)
  if (isCustomerView(ctx.actor, claim)) {
    if (INTERNAL_CATEGORIES.includes(doc.category)) throw notFound('Document not found')
  } else {
    requireTab(ctx.actor, claim, 'documents')
  }
  const buffer = await ctx.storage.get(doc.storage_path)
  await recordAudit(ctx.db, ctx.actor, {
    action: 'DOCUMENT_DOWNLOADED',
    entityType: 'document',
    entityId: doc.id,
    claimId: doc.claim_id,
    metadata: { fileName: doc.file_name },
  })
  return { doc, buffer }
}

export async function versions(ctx, documentId) {
  const doc = await ctx.db.findById('documents', documentId)
  if (!doc) throw notFound('Document not found')
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, doc.claim_id)
  const customer = isCustomerView(ctx.actor, claim)
  if (!customer) requireTab(ctx.actor, claim, 'documents')
  const rows = await ctx.db.findMany('documents', { where: { document_group_id: doc.document_group_id }, orderBy: [['version_no', 'desc']] })
  const names = customer ? {} : await profileMap(ctx.db, rows.flatMap((d) => [d.uploaded_by, d.reviewed_by, d.reviewer_id]))
  return rows.map((d) => presentDocument(d, names, customer))
}

export async function reviewQueue(ctx, query) {
  requirePermission(ctx.actor, 'documents.review')
  const scope = await claimScope(ctx.db, ctx.actor)
  const claimIds = (await ctx.db.findMany('claims', { where: { $and: [scope, { status: { ne: 'DRAFT' } }] }, columns: ['id'] })).map((c) => c.id)
  const where = { claim_id: { in: claimIds }, status: query.status, category: query.category }
  if (query.mine === 'true') where.reviewer_id = ctx.actor.id
  const orderBy = query.status === 'PENDING_REVIEW' ? [['uploaded_at', 'asc']] : [['reviewed_at', 'desc']]
  const [docs, total] = await Promise.all([
    ctx.db.findMany('documents', { where, orderBy, ...toOffset(query) }),
    ctx.db.count('documents', where),
  ])
  const claims = docs.length
    ? await ctx.db.findMany('claims', {
        where: { id: { in: [...new Set(docs.map((d) => d.claim_id))] } },
        columns: ['id', 'claim_number', 'status', 'priority', 'claim_type', 'customer_id'],
      })
    : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const names = await profileMap(ctx.db, [...docs.flatMap((d) => [d.uploaded_by, d.reviewer_id, d.reviewed_by]), ...claims.map((c) => c.customer_id)])
  return {
    items: docs.map((d) => ({
      ...presentDocument(d, names),
      claim_number: claimMap[d.claim_id]?.claim_number,
      claim_status: claimMap[d.claim_id]?.status,
      claim_priority: claimMap[d.claim_id]?.priority,
      claim_type: claimMap[d.claim_id]?.claim_type,
      customer_name: nameOf(names, claimMap[d.claim_id]?.customer_id),
    })),
    meta: pageMeta(query, total),
  }
}

export async function reviewDocument(ctx, documentId, { decision, comment, rejectionReason }) {
  requirePermission(ctx.actor, 'documents.review')
  return ctx.db.tx(async (t) => {
    const doc = await t.findOne('documents', { id: documentId }, { forUpdate: true })
    if (!doc) throw notFound('Document not found')
    await loadAccessibleClaim(t, ctx.actor, doc.claim_id)
    const claim = await lockClaim(t, doc.claim_id)
    requireStaffView(ctx.actor, claim)
    requireNotOwnClaim(ctx.actor, claim)
    if (doc.status !== 'PENDING_REVIEW') {
      throw businessRule('ALREADY_REVIEWED', `This document is already ${doc.status.toLowerCase().replace('_', ' ')}`)
    }
    if (doc.uploaded_by === ctx.actor.id) {
      throw forbidden('You cannot review a document you uploaded', 'SELF_REVIEW_FORBIDDEN')
    }

    const accepted = decision === 'ACCEPT'
    const updated = await t.updateById('documents', doc.id, {
      status: accepted ? 'ACCEPTED' : 'REJECTED',
      reviewed_by: ctx.actor.id,
      reviewed_at: new Date(),
      review_comment: comment || null,
      rejection_reason: accepted ? null : rejectionReason,
      reviewer_id: doc.reviewer_id || ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, {
      action: 'DOCUMENT_REVIEWED',
      entityType: 'document',
      entityId: doc.id,
      claimId: claim.id,
      before: doc,
      after: updated,
      metadata: { decision, comments: comment, reason: rejectionReason },
    })

    await notify(ctx, t, {
      recipientIds: [claim.customer_id],
      claimId: claim.id,
      type: accepted ? 'DOCUMENT_ACCEPTED' : 'DOCUMENT_REJECTED',
      title: accepted ? `Document accepted: ${doc.file_name}` : `Document needs attention: ${doc.file_name}`,
      message: accepted
        ? `Your ${humanize(doc.category).toLowerCase()} for claim ${claim.claim_number} has been accepted.`
        : `Your ${humanize(doc.category).toLowerCase()} for claim ${claim.claim_number} was not accepted: ${rejectionReason}. Please upload a replacement.`,
      link: claimLink(claim, true),
    })

    let claimAfter = claim
    if (!accepted) {
      await t.insert('information_requests', {
        claim_id: claim.id,
        request_type: 'DOCUMENT',
        document_category: doc.category,
        message: `Please upload a replacement ${humanize(doc.category).toLowerCase()}: ${rejectionReason}`,
        requested_by: ctx.actor.id,
        due_at: hoursFromNow(7 * 24),
      })
      await t.insert('tasks', {
        claim_id: claim.id,
        title: `Follow up rejected ${humanize(doc.category)}: ${doc.file_name}`,
        description: `Rejected because: ${rejectionReason}. Confirm the claimant uploads a replacement.`,
        task_type: 'DOCUMENT_FOLLOW_UP',
        assignee_id: ctx.actor.id,
        assigned_role: ROLES.DOCUMENT_REVIEWER,
        priority: claim.priority,
        due_at: hoursFromNow(7 * 24),
        created_by: ctx.actor.id,
      })
      if (claim.status === 'DOCUMENT_REVIEW') {
        claimAfter = await transitionClaim(ctx, t, claim, 'DOCUMENTS_REQUIRED', {
          reason: `${humanize(doc.category)} rejected: ${rejectionReason}`,
        })
      }
    } else {
      await t.update(
        'tasks',
        { claim_id: claim.id, task_type: 'DOCUMENT_FOLLOW_UP', status: { in: ['OPEN', 'IN_PROGRESS'] }, title: { ilike: `%${humanize(doc.category)}%` } },
        { status: 'DONE', completed_at: new Date(), completed_by: ctx.actor.id },
      )
    }
    return { document: updated, claimStatus: claimAfter.status }
  })
}

export async function assignReviewer(ctx, documentId, { reviewerId }) {
  requirePermission(ctx.actor, 'documents.assignReviewer')
  return ctx.db.tx(async (t) => {
    const doc = await t.findOne('documents', { id: documentId }, { forUpdate: true })
    if (!doc) throw notFound('Document not found')
    const claim = await loadAccessibleClaim(t, ctx.actor, doc.claim_id)
    requireStaffView(ctx.actor, claim)
    if (doc.status !== 'PENDING_REVIEW') throw businessRule('ALREADY_REVIEWED', 'Only documents awaiting review can be assigned')
    const roles = (await t.findMany('user_roles', { where: { user_id: reviewerId } })).map((r) => r.role_code)
    if (!roles.includes(ROLES.DOCUMENT_REVIEWER) && !roles.includes(ROLES.CLAIMS_MANAGER)) {
      throw validationError('Reviewer must hold DOCUMENT_REVIEWER or CLAIMS_MANAGER')
    }
    if (ctx.actor.roles.every((r) => r === ROLES.DOCUMENT_REVIEWER) && reviewerId !== ctx.actor.id) {
      throw forbidden('Document reviewers can only assign documents to themselves')
    }
    const updated = await t.updateById('documents', doc.id, { reviewer_id: reviewerId, review_assigned_at: new Date() })
    await recordAudit(t, ctx.actor, { action: 'DOCUMENT_REVIEWER_ASSIGNED', entityType: 'document', entityId: doc.id, claimId: doc.claim_id, before: doc, after: updated })
    if (reviewerId !== ctx.actor.id) {
      await notify(ctx, t, {
        recipientIds: [reviewerId],
        claimId: doc.claim_id,
        type: 'TASK_ASSIGNED',
        title: `Document review assigned: ${doc.file_name}`,
        message: `Please review ${humanize(doc.category).toLowerCase()} on claim ${claim.claim_number}.`,
        link: claimLink(claim, false),
        email: false,
      })
    }
    return updated
  })
}

// ---------------------------------------------------------------------------
// Information requests (missing documents / additional information)
// ---------------------------------------------------------------------------
export async function listClaimRequests(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  const rows = await ctx.db.findMany('information_requests', { where: { claim_id: claimId }, orderBy: [['created_at', 'desc']] })
  if (isCustomerView(ctx.actor, claim)) return rows.map(({ requested_by, ...r }) => r)
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.requested_by, r.responded_by]))
  return rows.map((r) => ({ ...r, requested_by_name: nameOf(names, r.requested_by), responded_by_name: nameOf(names, r.responded_by) }))
}

export async function listMyRequests(ctx, query) {
  const scope = await claimScope(ctx.db, ctx.actor)
  if (!scope) throw forbidden()
  const claims = await ctx.db.findMany('claims', { where: scope, columns: ['id', 'claim_number', 'customer_id', 'status'] })
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const where = { claim_id: { in: claims.map((c) => c.id) } }
  if (query.status) where.status = query.status
  const [rows, total] = await Promise.all([
    ctx.db.findMany('information_requests', { where, orderBy: [['status', 'desc'], ['created_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('information_requests', where),
  ])
  return {
    items: rows.map((r) => ({ ...r, claim_number: claimMap[r.claim_id]?.claim_number, is_mine: claimMap[r.claim_id]?.customer_id === ctx.actor.id })),
    meta: pageMeta(query, total),
  }
}

export async function createInformationRequest(ctx, claimId, input) {
  requirePermission(ctx.actor, 'documents.requestMissing')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, claimId)
    const claim = await lockClaim(t, claimId)
    requireStaffView(ctx.actor, claim)
    requireNotOwnClaim(ctx.actor, claim)
    if (!ACTIVE_STATUSES.includes(claim.status) && claim.status !== 'ON_HOLD') {
      throw businessRule('INVALID_STAGE', 'Requests can only be raised on open claims')
    }
    const request = await t.insert('information_requests', {
      claim_id: claimId,
      request_type: input.requestType,
      document_category: input.requestType === 'DOCUMENT' ? input.documentCategory : null,
      message: input.message,
      due_at: input.dueAt || hoursFromNow(7 * 24),
      requested_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, { action: 'INFORMATION_REQUESTED', entityType: 'information_request', entityId: request.id, claimId, after: request })
    await notify(ctx, t, {
      recipientIds: [claim.customer_id],
      claimId,
      type: input.requestType === 'DOCUMENT' ? 'DOCUMENTS_REQUIRED' : 'INFORMATION_REQUESTED',
      title: input.requestType === 'DOCUMENT' ? `Document needed for claim ${claim.claim_number}` : `Information needed for claim ${claim.claim_number}`,
      message: input.message,
      link: claimLink(claim, true),
    })
    return request
  })
}

export async function respondToRequest(ctx, requestId, { responseText }) {
  return ctx.db.tx(async (t) => {
    const request = await t.findOne('information_requests', { id: requestId }, { forUpdate: true })
    if (!request) throw notFound('Request not found')
    const claim = await loadAccessibleClaim(t, ctx.actor, request.claim_id)
    if (!isCustomerView(ctx.actor, claim)) throw forbidden('Only the claimant can respond to this request')
    if (request.status !== 'OPEN') throw businessRule('REQUEST_NOT_OPEN', 'This request is no longer open')
    if (request.request_type === 'DOCUMENT') {
      throw businessRule('UPLOAD_REQUIRED', 'Respond to document requests by uploading the requested document')
    }
    const updated = await t.updateById('information_requests', requestId, {
      status: 'RESPONDED',
      response_text: responseText,
      responded_by: ctx.actor.id,
      responded_at: new Date(),
    })
    await recordAudit(t, ctx.actor, { action: 'INFORMATION_PROVIDED', entityType: 'information_request', entityId: requestId, claimId: claim.id, before: request, after: updated })
    await notify(ctx, t, {
      recipientIds: [request.requested_by],
      claimId: claim.id,
      type: 'INFORMATION_REQUESTED',
      title: `Customer responded on ${claim.claim_number}`,
      message: responseText.length > 200 ? `${responseText.slice(0, 197)}...` : responseText,
      link: claimLink(claim, false),
      email: false,
    })
    return updated
  })
}

export async function closeRequest(ctx, requestId) {
  requirePermission(ctx.actor, 'documents.requestMissing')
  return ctx.db.tx(async (t) => {
    const request = await t.findOne('information_requests', { id: requestId }, { forUpdate: true })
    if (!request) throw notFound('Request not found')
    const claim = await loadAccessibleClaim(t, ctx.actor, request.claim_id)
    requireStaffView(ctx.actor, claim)
    if (!['OPEN', 'RESPONDED'].includes(request.status)) throw businessRule('REQUEST_NOT_OPEN', 'Request is already closed')
    const updated = await t.updateById('information_requests', requestId, {
      status: request.status === 'OPEN' ? 'CANCELLED' : 'CLOSED',
      closed_at: new Date(),
    })
    await recordAudit(t, ctx.actor, { action: 'INFORMATION_REQUEST_CLOSED', entityType: 'information_request', entityId: requestId, claimId: claim.id, before: request, after: updated })
    return updated
  })
}
