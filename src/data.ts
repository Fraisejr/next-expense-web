import type { AppData } from './types'

const today = new Date()
const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
const dateInMonth = (day: number) => {
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const safeDay = String(Math.min(day, today.getDate())).padStart(2, '0')
  return `${year}-${month}-${safeDay}`
}

export const seedData: AppData = {
  accounts: [
    { id: 'checking', name: 'Everyday checking', type: 'Checking', balanceMinor: 384216, color: '#234e46', currency: 'EUR', scope: 'Personal', closed: false, autoSync: false },
    { id: 'savings', name: 'Rainy day', type: 'Savings', balanceMinor: 1248000, color: '#d68853', currency: 'EUR', scope: 'Personal', closed: false },
    { id: 'wallet', name: 'Wallet', type: 'Cash', balanceMinor: 8640, color: '#777a6d', currency: 'EUR', scope: 'Personal', closed: false },
  ],
  categories: [
    { id: 'salary', name: 'Salary', color: '#2f6f62', icon: 'briefcase', reportGroup: 'income', hidden: false },
    { id: 'housing', name: 'Housing', color: '#cc7048', icon: 'house', reportGroup: 'expense', hidden: false },
    { id: 'groceries', name: 'Groceries', color: '#738c5a', icon: 'basket', reportGroup: 'expense', hidden: false },
    { id: 'transport', name: 'Transport', color: '#d49b4d', icon: 'car', reportGroup: 'expense', hidden: false },
    { id: 'dining', name: 'Dining out', color: '#9b6a71', icon: 'utensils', reportGroup: 'expense', hidden: false },
    { id: 'fun', name: 'Fun & leisure', color: '#5d7d91', icon: 'sparkles', reportGroup: 'expense', hidden: false },
    { id: 'bills', name: 'Bills', color: '#7f7062', icon: 'receipt', reportGroup: 'expense', hidden: false },
  ],
  budgets: [
    { id: 'budget-housing', month: currentMonth, categoryId: 'housing', scope: 'Personal', amountMinor: 145000 },
    { id: 'budget-groceries', month: currentMonth, categoryId: 'groceries', scope: 'Personal', amountMinor: 52000 },
    { id: 'budget-transport', month: currentMonth, categoryId: 'transport', scope: 'Personal', amountMinor: 26000 },
    { id: 'budget-dining', month: currentMonth, categoryId: 'dining', scope: 'Personal', amountMinor: 24000 },
    { id: 'budget-fun', month: currentMonth, categoryId: 'fun', scope: 'Personal', amountMinor: 18000 },
    { id: 'budget-bills', month: currentMonth, categoryId: 'bills', scope: 'Personal', amountMinor: 39000 },
  ],
  payees: [
    { id: 'green-market', name: 'Green Market' },
    { id: 'northline-energy', name: 'Northline Energy' },
    { id: 'little-lemon', name: 'Little Lemon' },
    { id: 'city-transit', name: 'City Transit' },
    { id: 'oak-stone-realty', name: 'Oak & Stone Realty' },
    { id: 'cinema-lumiere', name: 'Cinema Lumière' },
    { id: 'acme-studio', name: 'Acme Studio' },
  ],
  transactions: [
    { id: 't1', date: dateInMonth(28), payee: 'Green Market', payeeId: 'green-market', note: 'Weekly groceries', amountMinor: 8420, type: 'expense', accountId: 'checking', categoryId: 'groceries', currency: 'EUR' },
    { id: 't2', date: dateInMonth(26), payee: 'Northline Energy', payeeId: 'northline-energy', amountMinor: 11280, type: 'expense', accountId: 'checking', categoryId: 'bills', currency: 'EUR' },
    { id: 't3', date: dateInMonth(24), payee: 'Little Lemon', payeeId: 'little-lemon', note: 'Dinner with Alex', amountMinor: 6450, type: 'expense', accountId: 'checking', categoryId: 'dining', currency: 'EUR' },
    { id: 't4', date: dateInMonth(20), payee: 'City Transit', payeeId: 'city-transit', amountMinor: 4600, type: 'expense', accountId: 'checking', categoryId: 'transport', currency: 'EUR' },
    { id: 't5', date: dateInMonth(15), payee: 'Oak & Stone Realty', payeeId: 'oak-stone-realty', amountMinor: 145000, type: 'expense', accountId: 'checking', categoryId: 'housing', currency: 'EUR' },
    { id: 't6', date: dateInMonth(10), payee: 'Cinema Lumière', payeeId: 'cinema-lumiere', amountMinor: 3100, type: 'expense', accountId: 'checking', categoryId: 'fun', currency: 'EUR' },
    { id: 't7', date: dateInMonth(8), payee: 'Green Market', payeeId: 'green-market', amountMinor: 12634, type: 'expense', accountId: 'checking', categoryId: 'groceries', currency: 'EUR' },
    { id: 't8', date: dateInMonth(1), payee: 'Acme Studio', payeeId: 'acme-studio', note: 'Monthly salary', amountMinor: 475000, type: 'income', accountId: 'checking', categoryId: 'salary', currency: 'EUR' },
  ],
  settings: { estimatedCompanyTaxRateBps: 2000 },
}
