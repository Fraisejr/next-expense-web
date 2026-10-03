import assert from 'node:assert/strict'
import test from 'node:test'
import { annualSummaryKey, calculateAnnualSpending } from './annual-spending.ts'
import type { Category, Transaction } from './types'

const categories = ['personal_expense', 'company_expense', 'personal_tax', 'company_revenue'].map((reportGroup) => ({ id: reportGroup, reportGroup })) as Category[]
const data = { categories, fxRates: [{ id: 'fx', date: '2026-01-01', baseCurrency: 'USD', quoteCurrency: 'EUR', rateHundredths: 150 }] }
const transaction = (categoryId: string, amountMinor: number, overrides: Partial<Transaction> = {}): Transaction => ({
  id: Math.random().toString(), accountId: 'bank', payee: 'Store', date: '2026-10-03', type: 'expense', categoryId, amountMinor, currency: 'EUR', ...overrides,
})

test('annual summaries preserve scopes, refunds, taxes and per-transaction FX rounding', () => {
  const summary = calculateAnnualSpending([
    transaction('personal_expense', 100), transaction('personal_expense', 20, { type: 'income' }),
    transaction('company_expense', 1, { currency: 'USD' }), transaction('company_expense', 1, { currency: 'USD' }),
    transaction('personal_tax', 25), transaction('company_revenue', 200, { type: 'income' }),
    transaction('personal_expense', 10, { date: '2025-01-01' }),
    transaction('personal_expense', 900, { date: '2026-10-04' }), transaction('personal_expense', 900, { type: 'transfer' }),
  ], data, 'EUR', '2026-10-03')
  assert.deepEqual(summary.Personal, [{ year: 2025, income: 0, expenses: 10, taxes: 0 }, { year: 2026, income: 0, expenses: 80, taxes: 25 }])
  assert.deepEqual(summary.Company, [{ year: 2026, income: 200, expenses: 4, taxes: 0 }])
  assert.deepEqual(summary.Combined[1], { year: 2026, income: 200, expenses: 84, taxes: 25 })
})

test('summary cache key follows calculation inputs but ignores category order and unrelated changes', () => {
  const key = annualSummaryKey('a', 'EUR', '2026-10-03', data)
  assert.equal(annualSummaryKey('a', 'EUR', '2026-10-03', { ...data, categories: [...categories].reverse() }), key)
  assert.notEqual(annualSummaryKey('a', 'USD', '2026-10-03', data), key)
  assert.notEqual(annualSummaryKey('a', 'EUR', '2026-10-04', data), key)
  assert.notEqual(annualSummaryKey('b', 'EUR', '2026-10-03', data), key)
  assert.notEqual(annualSummaryKey('a', 'EUR', '2026-10-03', { ...data, fxRates: [{ ...data.fxRates[0], rateHundredths: 160 }] }), key)
  assert.notEqual(annualSummaryKey('a', 'EUR', '2026-10-03', { ...data, categories: [] }), key)
})
