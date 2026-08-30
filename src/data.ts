import type { AppData } from './types'

const today = new Date()
const dateInMonth = (day: number) => {
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const safeDay = String(Math.min(day, today.getDate())).padStart(2, '0')
  return `${year}-${month}-${safeDay}`
}

export const seedData: AppData = {
  accounts: [
    { id: 'checking', name: 'Everyday checking', type: 'Checking', balanceMinor: 384216, color: '#234e46', currency: 'EUR' },
    { id: 'savings', name: 'Rainy day', type: 'Savings', balanceMinor: 1248000, color: '#d68853', currency: 'EUR' },
    { id: 'wallet', name: 'Wallet', type: 'Cash', balanceMinor: 8640, color: '#777a6d', currency: 'EUR' },
  ],
  categories: [
    { id: 'salary', name: 'Salary', budgetMinor: 0, color: '#2f6f62', icon: 'briefcase', kind: 'income' },
    { id: 'housing', name: 'Housing', budgetMinor: 145000, color: '#cc7048', icon: 'house', kind: 'expense' },
    { id: 'groceries', name: 'Groceries', budgetMinor: 52000, color: '#738c5a', icon: 'basket', kind: 'expense' },
    { id: 'transport', name: 'Transport', budgetMinor: 26000, color: '#d49b4d', icon: 'car', kind: 'expense' },
    { id: 'dining', name: 'Dining out', budgetMinor: 24000, color: '#9b6a71', icon: 'utensils', kind: 'expense' },
    { id: 'fun', name: 'Fun & leisure', budgetMinor: 18000, color: '#5d7d91', icon: 'sparkles', kind: 'expense' },
    { id: 'bills', name: 'Bills', budgetMinor: 39000, color: '#7f7062', icon: 'receipt', kind: 'expense' },
  ],
  transactions: [
    { id: 't1', date: dateInMonth(28), merchant: 'Green Market', note: 'Weekly groceries', amountMinor: 8420, type: 'expense', accountId: 'checking', categoryId: 'groceries', currency: 'EUR' },
    { id: 't2', date: dateInMonth(26), merchant: 'Northline Energy', amountMinor: 11280, type: 'expense', accountId: 'checking', categoryId: 'bills', currency: 'EUR' },
    { id: 't3', date: dateInMonth(24), merchant: 'Little Lemon', note: 'Dinner with Alex', amountMinor: 6450, type: 'expense', accountId: 'checking', categoryId: 'dining', currency: 'EUR' },
    { id: 't4', date: dateInMonth(20), merchant: 'City Transit', amountMinor: 4600, type: 'expense', accountId: 'checking', categoryId: 'transport', currency: 'EUR' },
    { id: 't5', date: dateInMonth(15), merchant: 'Oak & Stone Realty', amountMinor: 145000, type: 'expense', accountId: 'checking', categoryId: 'housing', currency: 'EUR' },
    { id: 't6', date: dateInMonth(10), merchant: 'Cinema Lumière', amountMinor: 3100, type: 'expense', accountId: 'checking', categoryId: 'fun', currency: 'EUR' },
    { id: 't7', date: dateInMonth(8), merchant: 'Green Market', amountMinor: 12634, type: 'expense', accountId: 'checking', categoryId: 'groceries', currency: 'EUR' },
    { id: 't8', date: dateInMonth(1), merchant: 'Acme Studio', note: 'Monthly salary', amountMinor: 475000, type: 'income', accountId: 'checking', categoryId: 'salary', currency: 'EUR' },
  ],
}
