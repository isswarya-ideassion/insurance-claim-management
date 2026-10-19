import { INCIDENT_CATEGORIES } from '../../../shared/constants.js'

/**
 * Checks a policy against the database for a prospective or submitted claim.
 * Returns { eligible, reasons[], checks{} } — used for customer submission,
 * staff policy verification and the policyEligible workflow guard.
 */
export function evaluatePolicyEligibility(policy, { customerId, incidentAt, claimType, incidentCategory, estimatedLoss }) {
  const reasons = []
  const checks = {}

  checks.exists = Boolean(policy)
  if (!policy) {
    return { eligible: false, reasons: ['Policy not found for this account'], checks }
  }

  checks.ownership = policy.holder_id === customerId
  if (!checks.ownership) reasons.push('Policy does not belong to the claimant')

  checks.active = policy.status === 'ACTIVE'
  if (!checks.active) reasons.push(`Policy status is ${policy.status}`)

  if (incidentAt) {
    const incidentDay = new Date(incidentAt).toISOString().slice(0, 10)
    checks.inPeriod = incidentDay >= policy.effective_from && incidentDay <= policy.effective_to
    if (!checks.inPeriod) {
      reasons.push(`Incident date ${incidentDay} is outside the policy period ${policy.effective_from} to ${policy.effective_to}`)
    }
    checks.notFuture = new Date(incidentAt).getTime() <= Date.now() + 5 * 60_000
    if (!checks.notFuture) reasons.push('Incident date cannot be in the future')
  }

  if (claimType) {
    checks.typeMatch = claimType === policy.policy_type
    if (!checks.typeMatch) reasons.push(`Claim type ${claimType} does not match policy type ${policy.policy_type}`)
  }

  if (incidentCategory) {
    checks.categoryCovered = (INCIDENT_CATEGORIES[policy.policy_type] || []).includes(incidentCategory)
    if (!checks.categoryCovered) reasons.push(`Incident category ${incidentCategory} is not covered by a ${policy.policy_type} policy`)
  }

  if (estimatedLoss != null) {
    checks.withinSumInsured = Number(estimatedLoss) <= Number(policy.sum_insured)
    if (!checks.withinSumInsured) reasons.push(`Estimated loss exceeds the sum insured (${policy.sum_insured})`)
  }

  return { eligible: reasons.length === 0, reasons, checks }
}

export async function checkClaimEligibility(t, claim) {
  const policy = claim.policy_id ? await t.findById('policies', claim.policy_id) : null
  return evaluatePolicyEligibility(policy, {
    customerId: claim.customer_id,
    incidentAt: claim.incident_at,
    claimType: claim.claim_type,
    incidentCategory: claim.incident_category,
    estimatedLoss: claim.estimated_loss,
  })
}
