import { createHash, randomUUID } from 'node:crypto'
import { fileTypeFromBuffer } from 'file-type'
import {
  ROLES,
  ALLOWED_UPLOAD_MIME_TYPES,
  ALLOWED_UPLOAD_EXTENSIONS,
  ACTIVE_STATUSES,
  INTERNAL_DOCUMENT_TYPES,
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

const CUSTOMER_UPLOAD_STATUSES = ['DRAFT', 'SUBMITTED', 'POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW', 'INVESTIGATION', 'REOPENED']
const REQUEST_DAYS = 7

function presentDocument(doc, names = {}, customer = false) {
  const base = {
    id: doc.id,
    claim_id: doc.claim_id,
    version: doc.version,
    doc_type: doc.doc_type,
    file_name: doc.file_name,
    mime_type: doc.mime_type,
    size_bytes: doc.size_bytes,
    status: doc.status,
    source: doc.source,
    received_at: doc.received_at,
    reviewed_at: doc.reviewed_at,
    rejection_reason: doc.rejection_reason,
    artifact_requirement_id: doc.artifact_requirement_id,
  }
  if (customer) return base
  return {
    ...base,
    sha256: doc.sha256,
    uploaded_by: doc.uploaded_by,
    uploaded_by_name: nameOf(names, doc.uploaded_by),
    reviewer_id: doc.reviewer_id,
    reviewer_name: nameOf(names, doc.reviewer_id),
    reviewed_by: doc.reviewed_by,
    reviewed_by_name: nameOf(names, doc.reviewed_by),
    review_comment: doc.review_comment,
    review_assigned_at: doc.review_assigned_at,
    extracted_fields: doc.extracted_fields,
  }
}

export async function listClaimDocuments(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  const customer = isCustomerView(ctx.actor, claim)
  if (!customer) requireTab(ctx.actor, claim, 'documents')
  const where = { claim_id: claimId }
  if (customer) where.doc_type = { nin: INTERNAL_DOCUMENT_TYPES }
  const docs = await ctx.db.findMany('documents', { where, orderBy: [['received_at', 'desc']] })
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

/** The requirement an upload answers: an explicit one, else the open request or required row for the type. */
async function requirementForUpload(t, claimId, docType, requirementId) {
  if (requirementId) {
    const row = await t.findOne('artifact_requirements', { id: requirementId, claim_id: claimId }, { forUpdate: true })
    if (!row) throw notFound('Artifact requirement not found on this claim')
    return row
  }
  return t.findOne(
    'artifact_requirements',
    { claim_id: claimId, requirement_type: 'DOCUMENT', doc_type: docType, status: { in: ['MISSING', 'REQUESTED', 'REJECTED'] } },
    { orderBy: [['is_required', 'desc'], ['created_at', 'asc']], forUpdate: true },
  )
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
    if (INTERNAL_DOCUMENT_TYPES.includes(fields.docType)) throw forbidden('This document type is reserved for staff')
  } else {
    requireTab(ctx.actor, claim, 'documents')
    requireNotOwnClaim(ctx.actor, claim)
    if (![...ACTIVE_STATUSES, 'ON_HOLD'].includes(claim.status)) {
      throw businessRule('UPLOAD_NOT_ALLOWED', 'Documents cannot be added to a claim in this status')
    }
  }

  const { mime, ext } = await sniffFile(file)
  const objectId = randomUUID()
  const storageKey = `claims/${claimId}/${objectId}.${ext}`
  const sha256 = createHash('sha256').update(file.buffer).digest('hex')
  const fileName = sanitizeFileName(file.originalname)

  return ctx.db.tx(async (t) => {
    const locked = await lockClaim(t, claimId)
    // File contents and metadata commit together, so a failed upload leaves nothing behind.
    await ctx.storage.put(storageKey, file.buffer, mime, t)
    const now = new Date()
    const fileColumns = { file_name: fileName, mime_type: mime, size_bytes: file.size, sha256, storage_key: storageKey }
    const requirement = await requirementForUpload(t, claimId, fields.docType, fields.artifactRequirementId)

    let doc
    if (fields.replacesDocumentId) {
      const previous = await t.findOne('documents', { id: fields.replacesDocumentId, claim_id: claimId }, { forUpdate: true })
      if (!previous) throw notFound('Document to replace was not found on this claim')
      await t.update('document_versions', { document_id: previous.id, version_no: previous.version }, { status: 'SUPERSEDED' })
      doc = await t.updateById('documents', previous.id, {
        ...fileColumns,
        version: previous.version + 1,
        status: 'PENDING_REVIEW',
        received_at: now,
        uploaded_by: ctx.actor.id,
        reviewed_by: null,
        reviewed_at: null,
        review_comment: null,
        rejection_reason: null,
        artifact_requirement_id: requirement?.id || previous.artifact_requirement_id,
      })
    } else {
      doc = await t.insert('documents', {
        ...fileColumns,
        claim_id: claimId,
        version: 1,
        doc_type: fields.docType,
        source: customer ? (fields.source === 'PWA' ? 'PWA' : 'WEB') : 'STAFF',
        uploaded_by: ctx.actor.id,
        received_at: now,
        artifact_requirement_id: requirement?.id || null,
        reviewer_id: locked.assigned_reviewer_id || null,
        review_assigned_at: locked.assigned_reviewer_id ? now : null,
      })
    }
    await t.insert('document_versions', {
      document_id: doc.id,
      version_no: doc.version,
      ...fileColumns,
      status: 'PENDING_REVIEW',
      uploaded_by: ctx.actor.id,
      uploaded_at: now,
      change_reason: fields.replacesDocumentId ? fields.changeReason || 'Replacement upload' : null,
    })

    if (requirement) {
      await t.updateById('artifact_requirements', requirement.id, {
        status: 'RECEIVED',
        document_id: doc.id,
        responded_by: ctx.actor.id,
        received_at: now,
        response_text: `Uploaded ${doc.file_name}`,
      })
    }

    await recordAudit(t, ctx.actor, {
      action: 'DOCUMENT_UPLOADED',
      entityType: 'document',
      entityId: doc.id,
      claimId,
      after: { ...doc, storage_key: undefined },
      metadata: { docType: doc.doc_type, version: doc.version, sizeBytes: file.size, requirementId: requirement?.id || null },
    })

    if (customer && locked.assigned_reviewer_id) {
      await notify(ctx, t, {
        recipientIds: [locked.assigned_reviewer_id],
        claimId,
        type: 'TASK_ASSIGNED',
        title: `New document on ${locked.claim_number || 'a claim'}`,
        message: `${humanize(doc.doc_type)} uploaded and awaiting review.`,
        link: claimLink(locked, false),
        email: false,
      })
    }

    let claimAfter = locked
    if (customer && locked.status === 'DOCUMENTS_REQUIRED') {
      const stillOpen = await t.count('artifact_requirements', { claim_id: claimId, status: 'REQUESTED', requirement_type: 'DOCUMENT' })
      if (stillOpen === 0) {
        claimAfter = await transitionClaim(ctx, t, locked, 'DOCUMENT_REVIEW', { reason: 'Requested documents provided by claimant' })
      }
    }
    return { document: presentDocument(doc, {}, customer), claimStatus: claimAfter.status }
  })
}

/** Streams the current version, or a specific earlier version for staff. */
export async function downloadDocument(ctx, documentId, versionNo = null) {
  const doc = await ctx.db.findById('documents', documentId)
  if (!doc) throw notFound('Document not found')
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, doc.claim_id)
  const customer = isCustomerView(ctx.actor, claim)
  if (customer) {
    if (INTERNAL_DOCUMENT_TYPES.includes(doc.doc_type)) throw notFound('Document not found')
  } else {
    requireTab(ctx.actor, claim, 'documents')
  }
  let file = doc
  if (versionNo && versionNo !== doc.version) {
    file = await ctx.db.findOne('document_versions', { document_id: doc.id, version_no: versionNo })
    if (!file) throw notFound('Document version not found')
  }
  const buffer = await ctx.storage.get(file.storage_key)
  await recordAudit(ctx.db, ctx.actor, {
    action: 'DOCUMENT_DOWNLOADED',
    entityType: 'document',
    entityId: doc.id,
    claimId: doc.claim_id,
    metadata: { fileName: file.file_name, version: file.version_no ?? doc.version },
  })
  return { doc: { ...doc, file_name: file.file_name, mime_type: file.mime_type }, buffer }
}

export async function versions(ctx, documentId) {
  const doc = await ctx.db.findById('documents', documentId)
  if (!doc) throw notFound('Document not found')
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, doc.claim_id)
  const customer = isCustomerView(ctx.actor, claim)
  if (customer && INTERNAL_DOCUMENT_TYPES.includes(doc.doc_type)) throw notFound('Document not found')
  if (!customer) requireTab(ctx.actor, claim, 'documents')
  const rows = await ctx.db.findMany('document_versions', { where: { document_id: documentId }, orderBy: [['version_no', 'desc']] })
  const names = customer ? {} : await profileMap(ctx.db, rows.flatMap((v) => [v.uploaded_by, v.reviewed_by]))
  return rows.map(({ storage_key: _key, ...v }) =>
    customer
      ? { id: v.id, document_id: v.document_id, version_no: v.version_no, file_name: v.file_name, status: v.status, uploaded_at: v.uploaded_at, rejection_reason: v.rejection_reason }
      : { ...v, uploaded_by_name: nameOf(names, v.uploaded_by), reviewed_by_name: nameOf(names, v.reviewed_by) },
  )
}

export async function reviewQueue(ctx, query) {
  requirePermission(ctx.actor, 'documents.review')
  const scope = await claimScope(ctx.db, ctx.actor)
  const claimIds = (await ctx.db.findMany('claims', { where: { $and: [scope, { status: { ne: 'DRAFT' } }] }, columns: ['id'] })).map((c) => c.id)
  const where = { claim_id: { in: claimIds }, status: query.status, doc_type: query.docType }
  if (query.mine === 'true') where.reviewer_id = ctx.actor.id
  const orderBy = query.status === 'PENDING_REVIEW' ? [['received_at', 'asc']] : [['reviewed_at', 'desc']]
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
    const now = new Date()
    const status = accepted ? 'ACCEPTED' : 'REJECTED'
    const updated = await t.updateById('documents', doc.id, {
      status,
      reviewed_by: ctx.actor.id,
      reviewed_at: now,
      review_comment: comment || null,
      rejection_reason: accepted ? null : rejectionReason,
      reviewer_id: doc.reviewer_id || ctx.actor.id,
    })
    await t.update('document_versions', { document_id: doc.id, version_no: doc.version }, {
      status,
      reviewed_by: ctx.actor.id,
      reviewed_at: now,
      rejection_reason: accepted ? null : rejectionReason,
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
        ? `Your ${humanize(doc.doc_type).toLowerCase()} for claim ${claim.claim_number} has been accepted.`
        : `Your ${humanize(doc.doc_type).toLowerCase()} for claim ${claim.claim_number} was not accepted: ${rejectionReason}. Please upload a replacement.`,
      link: claimLink(claim, true),
    })

    // The required-artifact row for this type follows the review outcome.
    const requirement = await t.findOne(
      'artifact_requirements',
      { claim_id: claim.id, requirement_type: 'DOCUMENT', doc_type: doc.doc_type, status: { in: ['MISSING', 'REQUESTED', 'RECEIVED', 'REJECTED'] } },
      { orderBy: [['is_required', 'desc'], ['created_at', 'asc']], forUpdate: true },
    )

    let claimAfter = claim
    if (!accepted) {
      // A rejection re-requests the artifact from the client on the same requirement.
      const message = `Please upload a replacement ${humanize(doc.doc_type).toLowerCase()}: ${rejectionReason}`
      const due = hoursFromNow(REQUEST_DAYS * 24)
      if (requirement) {
        await t.updateById('artifact_requirements', requirement.id, {
          status: 'REQUESTED',
          document_id: doc.id,
          request_message: message,
          requested_by: ctx.actor.id,
          requested_at: now,
          due_at: due,
        })
      } else {
        await t.insert('artifact_requirements', {
          claim_id: claim.id,
          requirement_type: 'DOCUMENT',
          doc_type: doc.doc_type,
          status: 'REQUESTED',
          document_id: doc.id,
          request_message: message,
          requested_by: ctx.actor.id,
          requested_at: now,
          due_at: due,
        })
      }
      await t.insert('tasks', {
        claim_id: claim.id,
        title: `Follow up rejected ${humanize(doc.doc_type)}: ${doc.file_name}`,
        description: `Rejected because: ${rejectionReason}. Confirm the claimant uploads a replacement.`,
        type: 'DOCUMENT_FOLLOW_UP',
        owner_user_id: ctx.actor.id,
        owner_role: ROLES.DOCUMENT_REVIEWER,
        claimed_at: now,
        source_stage: claim.stage,
        priority: claim.priority,
        due_at: due,
        created_by: ctx.actor.id,
      })
      if (claim.status === 'DOCUMENT_REVIEW') {
        claimAfter = await transitionClaim(ctx, t, claim, 'DOCUMENTS_REQUIRED', {
          reason: `${humanize(doc.doc_type)} rejected: ${rejectionReason}`,
        })
      }
    } else {
      if (requirement) {
        await t.updateById('artifact_requirements', requirement.id, { status: 'ACCEPTED', document_id: doc.id, closed_at: now })
      }
      await t.update(
        'tasks',
        { claim_id: claim.id, type: 'DOCUMENT_FOLLOW_UP', status: { in: ['OPEN', 'IN_PROGRESS'] }, title: { ilike: `%${humanize(doc.doc_type)}%` } },
        { status: 'DONE', completed_at: now, completed_by: ctx.actor.id },
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
    if (!roles.includes(ROLES.DOCUMENT_REVIEWER)) throw validationError('Reviewer must hold DOCUMENT_REVIEWER')
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
        message: `Please review ${humanize(doc.doc_type).toLowerCase()} on claim ${claim.claim_number}.`,
        link: claimLink(claim, false),
        email: false,
      })
    }
    return updated
  })
}

// ---------------------------------------------------------------------------
// Artifact requirements: required artifacts plus document and information requests
// ---------------------------------------------------------------------------
function presentRequirement(r, names, customer) {
  if (customer) {
    const { requested_by: _r, responded_by: _s, waived_reason: _w, ...rest } = r
    return rest
  }
  return { ...r, requested_by_name: nameOf(names, r.requested_by), responded_by_name: nameOf(names, r.responded_by) }
}

export async function listClaimRequirements(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  const customer = isCustomerView(ctx.actor, claim)
  const where = { claim_id: claimId }
  if (customer) where.doc_type = { nin: INTERNAL_DOCUMENT_TYPES }
  const rows = await ctx.db.findMany('artifact_requirements', { where, orderBy: [['is_required', 'desc'], ['created_at', 'desc']] })
  const names = customer ? {} : await profileMap(ctx.db, rows.flatMap((r) => [r.requested_by, r.responded_by]))
  return rows.map((r) => presentRequirement(r, names, customer))
}

/** Requests across claims in the caller's scope; clients see what they still owe. */
export async function listRequests(ctx, query) {
  const scope = await claimScope(ctx.db, ctx.actor)
  if (!scope) throw forbidden()
  const claims = await ctx.db.findMany('claims', { where: scope, columns: ['id', 'claim_number', 'customer_id', 'status'] })
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const where = { claim_id: { in: claims.map((c) => c.id) }, requested_at: { ne: null } }
  if (query.status) where.status = query.status
  const [rows, total] = await Promise.all([
    ctx.db.findMany('artifact_requirements', { where, orderBy: [['status', 'desc'], ['requested_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('artifact_requirements', where),
  ])
  return {
    items: rows.map((r) => ({ ...r, claim_number: claimMap[r.claim_id]?.claim_number, is_mine: claimMap[r.claim_id]?.customer_id === ctx.actor.id })),
    meta: pageMeta(query, total),
  }
}

export async function createArtifactRequest(ctx, claimId, input) {
  requirePermission(ctx.actor, 'documents.requestMissing')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, claimId)
    const claim = await lockClaim(t, claimId)
    requireStaffView(ctx.actor, claim)
    requireNotOwnClaim(ctx.actor, claim)
    if (!ACTIVE_STATUSES.includes(claim.status) && claim.status !== 'ON_HOLD') {
      throw businessRule('INVALID_STAGE', 'Requests can only be raised on open claims')
    }
    const now = new Date()
    const request = {
      status: 'REQUESTED',
      request_message: input.message,
      due_at: input.dueAt || hoursFromNow(REQUEST_DAYS * 24),
      requested_by: ctx.actor.id,
      requested_at: now,
    }
    let row
    const required = input.requirementType === 'DOCUMENT'
      ? await t.findOne('artifact_requirements', { claim_id: claimId, doc_type: input.docType, is_required: true }, { forUpdate: true })
      : null
    if (required && required.status !== 'ACCEPTED') {
      row = await t.updateById('artifact_requirements', required.id, request)
    } else {
      row = await t.insert('artifact_requirements', {
        claim_id: claimId,
        requirement_type: input.requirementType,
        doc_type: input.requirementType === 'DOCUMENT' ? input.docType : null,
        ...request,
      })
    }
    await recordAudit(t, ctx.actor, { action: 'ARTIFACT_REQUESTED', entityType: 'artifact_requirement', entityId: row.id, claimId, after: row })
    await notify(ctx, t, {
      recipientIds: [claim.customer_id],
      claimId,
      type: input.requirementType === 'DOCUMENT' ? 'DOCUMENTS_REQUIRED' : 'INFORMATION_REQUESTED',
      title: input.requirementType === 'DOCUMENT' ? `Document needed for claim ${claim.claim_number}` : `Information needed for claim ${claim.claim_number}`,
      message: input.message,
      link: claimLink(claim, true),
    })
    return row
  })
}

export async function respondToRequest(ctx, requestId, { responseText }) {
  return ctx.db.tx(async (t) => {
    const request = await t.findOne('artifact_requirements', { id: requestId }, { forUpdate: true })
    if (!request) throw notFound('Request not found')
    const claim = await loadAccessibleClaim(t, ctx.actor, request.claim_id)
    if (!isCustomerView(ctx.actor, claim)) throw forbidden('Only the claimant can respond to this request')
    if (request.status !== 'REQUESTED') throw businessRule('REQUEST_NOT_OPEN', 'This request is no longer open')
    if (request.requirement_type === 'DOCUMENT') {
      throw businessRule('UPLOAD_REQUIRED', 'Respond to document requests by uploading the requested document')
    }
    const updated = await t.updateById('artifact_requirements', requestId, {
      status: 'RECEIVED',
      response_text: responseText,
      responded_by: ctx.actor.id,
      received_at: new Date(),
    })
    await recordAudit(t, ctx.actor, { action: 'INFORMATION_PROVIDED', entityType: 'artifact_requirement', entityId: requestId, claimId: claim.id, before: request, after: updated })
    await notify(ctx, t, {
      recipientIds: [request.requested_by],
      claimId: claim.id,
      type: 'INFORMATION_REQUESTED',
      title: `Client responded on ${claim.claim_number}`,
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
    const request = await t.findOne('artifact_requirements', { id: requestId }, { forUpdate: true })
    if (!request) throw notFound('Request not found')
    const claim = await loadAccessibleClaim(t, ctx.actor, request.claim_id)
    requireStaffView(ctx.actor, claim)
    if (request.is_required) throw businessRule('REQUIRED_ARTIFACT', 'Required artifacts are closed by review or a recorded document exception')
    if (!['REQUESTED', 'RECEIVED'].includes(request.status)) throw businessRule('REQUEST_NOT_OPEN', 'Request is already closed')
    const updated = await t.updateById('artifact_requirements', requestId, {
      status: request.status === 'REQUESTED' ? 'CANCELLED' : 'CLOSED',
      closed_at: new Date(),
    })
    await recordAudit(t, ctx.actor, { action: 'ARTIFACT_REQUEST_CLOSED', entityType: 'artifact_requirement', entityId: requestId, claimId: claim.id, before: request, after: updated })
    return updated
  })
}
