import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const requiredFiles = [
  'NextExpense.xcodeproj/project.pbxproj',
  'NextExpense/App/NextExpenseApp.swift',
  'NextExpense/App/ExpenseStore.swift',
  'NextExpense/App/NeonAPI.swift',
  'NextExpense/App/LiveExpenseStore.swift',
  'NextExpense/Features/LiveExpenseView.swift',
  'NextExpense/Models/ExpenseModels.swift',
  'NextExpense/Features/OverviewView.swift',
  'NextExpense/Features/ReviewInboxView.swift',
  'NextExpense/Features/AccountsView.swift',
  'NextExpense/Resources/Assets.xcassets/Contents.json',
  'NextExpense/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json',
  'NextExpenseTests/ExpenseStoreTests.swift',
  'README.md',
]

const failures = []
for (const relativePath of requiredFiles) {
  if (!existsSync(resolve(root, relativePath))) failures.push(`Missing ${relativePath}`)
}

function expectText(relativePath, snippets) {
  const path = resolve(root, relativePath)
  if (!existsSync(path)) return
  const contents = readFileSync(path, 'utf8')
  for (const snippet of snippets) {
    if (!contents.includes(snippet)) failures.push(`${relativePath} does not contain ${JSON.stringify(snippet)}`)
  }
}

expectText('NextExpense/App/ExpenseStore.swift', [
  'func approve(',
  'func reject(',
  'func sync(',
])
expectText('NextExpense/Features/OverviewView.swift', ['Budget', 'Net worth', 'Year spending'])
expectText('NextExpense/Features/ReviewInboxView.swift', ['Approve', 'Reject transaction', 'Select category'])
expectText('NextExpense/Features/AccountsView.swift', ['Sync now', 'Last synced'])
expectText('NextExpense/App/NextExpenseApp.swift', ['LiveExpenseView'])
expectText('NextExpense/App/NeonAPI.swift', ['set-auth-jwt', 'kSecAttrAccessibleWhenUnlockedThisDeviceOnly'])
expectText('NextExpense/App/LiveExpenseStore.swift', ['rpc/approve_bank_import_candidate', 'workspace_id'])
expectText('NextExpense/Features/LiveExpenseView.swift', ['Sign in', 'Continue with Google', 'Ledger'])
expectText('NextExpense.xcodeproj/project.pbxproj', [
  'productType = "com.apple.product-type.application";',
  'NextExpenseTests',
  'ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;',
])

const productionSources = [
  'NextExpense/App/NextExpenseApp.swift',
  'NextExpense/App/ExpenseStore.swift',
  'NextExpense/App/NeonAPI.swift',
  'NextExpense/App/LiveExpenseStore.swift',
  'NextExpense/Features/LiveExpenseView.swift',
  'NextExpense/Models/ExpenseModels.swift',
  'NextExpense/Features/OverviewView.swift',
  'NextExpense/Features/ReviewInboxView.swift',
  'NextExpense/Features/AccountsView.swift',
]
for (const relativePath of productionSources) {
  const path = resolve(root, relativePath)
  if (!existsSync(path)) continue
  const contents = readFileSync(path, 'utf8')
  if (/add transaction|new transaction/i.test(contents)) {
    failures.push(`${relativePath} introduces manual transaction entry, which is outside the MVP`)
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}

console.log(`Validated ${requiredFiles.length} required iOS MVP files and feature markers.`)
