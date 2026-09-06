import type { FxRate } from './types'

function applicableRate(sourceCurrency: string, targetCurrency: string, date: string, rates: FxRate[]) {
  const month = date.slice(0, 7)
  return rates
    .filter((rate) => rate.date.slice(0, 7) <= month && (
      (rate.baseCurrency === sourceCurrency && rate.quoteCurrency === targetCurrency)
      || (rate.baseCurrency === targetCurrency && rate.quoteCurrency === sourceCurrency)
    ))
    .sort((left, right) => right.date.localeCompare(left.date))[0]
}

export function convertMinor(
  amountMinor: number,
  sourceCurrency: string,
  targetCurrency: string,
  date: string,
  rates: FxRate[],
) {
  if (sourceCurrency === targetCurrency) return amountMinor
  const rate = applicableRate(sourceCurrency, targetCurrency, date, rates)
  if (!rate) return null

  // Legacy rates store hundredths of quote currency per unit of base currency:
  // EUR/SEK 1036 means EUR 1 = SEK 10.36.
  return rate.baseCurrency === sourceCurrency
    ? Math.round(amountMinor * rate.rateHundredths / 100)
    : Math.round(amountMinor * 100 / rate.rateHundredths)
}
