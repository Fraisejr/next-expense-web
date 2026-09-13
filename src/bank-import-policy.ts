export const zeroAmountReason = 'zero_amount'

export function zeroAmountAction(amountMinor: number, candidate?: { status?: unknown; decision_reason?: unknown }) {
  if (amountMinor === 0) return 'ignore'
  if (candidate?.status === 'rejected' && candidate.decision_reason === zeroAmountReason) return 'reopen'
  return 'unchanged'
}
