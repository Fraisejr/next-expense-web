const moneyFormatters = new Map<string, Intl.NumberFormat>()
export const monthName = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' })
export function formatMoney(amountMinor: number, currency = 'EUR') {
  let formatter = moneyFormatters.get(currency)
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-IE', { style: 'currency', currency })
    moneyFormatters.set(currency, formatter)
  }
  return formatter.format(amountMinor / 100)
}

export function parseMoneyToMinor(value: string, allowNegative = false) {
  const normalized = value.trim().replace(',', '.')
  const negative = normalized.startsWith('-')
  const unsigned = negative ? normalized.slice(1) : normalized
  if (!/^\d+(\.\d{0,2})?$/.test(unsigned) || (negative && !allowNegative)) return null
  const [whole, fraction = ''] = unsigned.split('.')
  const amountMinor = (Number(whole) * 100 + Number(fraction.padEnd(2, '0'))) * (negative ? -1 : 1)
  return Number.isSafeInteger(amountMinor) ? amountMinor : null
}

export function fromMonthKey(value: string | null) {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null
  const [year, month] = value.split('-').map(Number)
  return new Date(year, month - 1, 1)
}

export function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (!error || typeof error !== 'object') return fallback

  const details = error as Record<string, unknown>
  const parts = [details.message, details.details, details.hint, details.code]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
  return parts.length > 0 ? parts.join(' · ') : fallback
}

export function uid() {
  return crypto.randomUUID()
}

export function toMonthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

const shortDate = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' })
const shortDateWithYear = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' })

export function formatShortDate(value: string) {
  const date = new Date(`${value}T12:00:00`)
  return (date.getFullYear() === new Date().getFullYear() ? shortDate : shortDateWithYear).format(date)
}

export function formatCompactMoney(amountMinor: number, currency = 'EUR') {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1,
  }).format(amountMinor / 100)
}
