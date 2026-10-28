import { LOSS_TYPES } from '../../../shared/constants.js'

/**
 * Checks a policy for a prospective or submitted claim.
 * Returns { eligible, reasons[], checks{} } — used for client submission,
 * coverage verification and the policyEligible workflow guard.
 */
export function evaluatePolicyEligibility(policy, { customerId, lossDate, claimType, lossType, estimatedLoss }) {
  const reasons = []
  const checks = {}

  checks.exists = Boolean(policy)
  if (!policy) {
    return { eligible: false, reasons: ['Policy not found for this account'], checks }
  }

  checks.ownership = policy.insured_id === customerId
  if (!checks.ownership) reasons.push('Policy does not belong to the claimant')

  checks.active = policy.status === 'ACTIVE'
  if (!checks.active) reasons.push(`Policy status is ${policy.status}`)

  if (lossDate) {
    const lossDay = new Date(lossDate).toISOString().slice(0, 10)
    checks.inPeriod = lossDay >= policy.effective_date && lossDay <= policy.expiry_date
    if (!checks.inPeriod) {
      reasons.push(`Loss date ${lossDay} is outside the policy period ${policy.effective_date} to ${policy.expiry_date}`)
    }
    checks.notFuture = new Date(lossDate).getTime() <= Date.now() + 5 * 60_000
    if (!checks.notFuture) reasons.push('Loss date cannot be in the future')
  }

  if (claimType) {
    checks.typeMatch = claimType === policy.policy_type
    if (!checks.typeMatch) reasons.push(`Claim type ${claimType} does not match policy type ${policy.policy_type}`)
  }

  if (lossType) {
    checks.lossTypeCovered = (LOSS_TYPES[policy.policy_type] || []).includes(lossType)
    if (!checks.lossTypeCovered) reasons.push(`Loss type ${lossType} is not covered by a ${policy.policy_type} policy`)
  }

  if (estimatedLoss != null) {
    checks.withinSumInsured = Number(estimatedLoss) <= Number(policy.sum_insured)
    if (!checks.withinSumInsured) reasons.push(`Estimated loss exceeds the sum insured (${policy.sum_insured})`)
  }

  return { eligible: reasons.length === 0, reasons, checks }
}

/**
 * The policy as it applies to a claim: the frozen snapshot taken at FNOL once
 * the claim is submitted (coverage checks never read the live policy), the live
 * policy for drafts.
 */
export async function policyForClaim(t, claim) {
  if (claim.policy_snapshot_id) {
    const snapshot = await t.findById('policy_snapshots', claim.policy_snapshot_id)
    if (snapshot) return { ...snapshot.snapshot, snapshot_id: snapshot.id, snapshot_captured_at: snapshot.captured_at }
  }
  return claim.policy_id ? t.findById('policies', claim.policy_id) : null
}

export async function checkClaimEligibility(t, claim) {
  const policy = await policyForClaim(t, claim)
  return evaluatePolicyEligibility(policy, {
    customerId: claim.customer_id,
    lossDate: claim.loss_date,
    claimType: claim.claim_type,
    lossType: claim.loss_type,
    estimatedLoss: claim.estimated_loss,
  })
}
