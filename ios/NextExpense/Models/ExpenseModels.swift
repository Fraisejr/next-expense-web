import Foundation

struct BudgetCategory: Identifiable, Hashable {
    let id: UUID
    let name: String
    var spentMinor: Int
    let budgetMinor: Int
    let currency: String

    var progress: Double {
        guard budgetMinor > 0 else { return 0 }
        return min(max(Double(spentMinor) / Double(budgetMinor), 0), 1)
    }

    var remainingMinor: Int { budgetMinor - spentMinor }
    var isOverBudget: Bool { remainingMinor < 0 }
}

struct ExpenseAccount: Identifiable, Hashable {
    let id: UUID
    let name: String
    let balanceMinor: Int
    let currency: String
    let isConnected: Bool
    var lastSyncedAt: Date?
}

struct BankImportCandidate: Identifiable, Hashable {
    let id: UUID
    let accountName: String
    let date: Date
    let amountMinor: Int
    let currency: String
    var payee: String
    var categoryID: UUID?
    let note: String?
}

func formattedMoney(_ minorUnits: Int, currency: String) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = currency
    formatter.maximumFractionDigits = 2
    let amount = NSDecimalNumber(value: minorUnits).dividing(by: 100)
    return formatter.string(from: amount) ?? "\(currency) \(amount)"
}
