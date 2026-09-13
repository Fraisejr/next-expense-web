import Combine
import Foundation

@MainActor
final class ExpenseStore: ObservableObject {
    enum StoreError: Error, Equatable {
        case candidateNotFound
        case missingPayee
        case missingCategory
    }

    @Published private(set) var categories: [BudgetCategory]
    @Published private(set) var accounts: [ExpenseAccount]
    @Published private(set) var candidates: [BankImportCandidate]
    @Published private(set) var approvedTransactions: [BankImportCandidate] = []
    @Published private(set) var syncingAccountID: UUID?

    let yearSpendingGoalMinor: Int
    private let syncDelayNanoseconds: UInt64

    init(
        categories: [BudgetCategory],
        accounts: [ExpenseAccount],
        candidates: [BankImportCandidate],
        yearSpendingGoalMinor: Int,
        syncDelayNanoseconds: UInt64 = 650_000_000
    ) {
        self.categories = categories
        self.accounts = accounts
        self.candidates = candidates
        self.yearSpendingGoalMinor = yearSpendingGoalMinor
        self.syncDelayNanoseconds = syncDelayNanoseconds
    }

    var netWorthMinor: Int {
        accounts.reduce(0) { $0 + $1.balanceMinor }
    }

    var yearSpentMinor: Int {
        categories.reduce(0) { $0 + $1.spentMinor }
    }

    func approve(
        candidateID: UUID,
        payee: String,
        categoryID: UUID?
    ) async throws {
        guard let candidateIndex = candidates.firstIndex(where: { $0.id == candidateID }) else {
            throw StoreError.candidateNotFound
        }
        let trimmedPayee = payee.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPayee.isEmpty else {
            throw StoreError.missingPayee
        }
        guard let categoryID, let categoryIndex = categories.firstIndex(where: { $0.id == categoryID }) else {
            throw StoreError.missingCategory
        }

        // The first cut uses local demo data. This is the seam where the hosted
        // approve_bank_import_candidate endpoint will be called next.
        var approved = candidates[candidateIndex]
        approved.payee = trimmedPayee
        approved.categoryID = categoryID
        categories[categoryIndex].spentMinor += approved.amountMinor
        approvedTransactions.append(approved)
        candidates.remove(at: candidateIndex)
    }

    func reject(candidateID: UUID) {
        candidates.removeAll { $0.id == candidateID }
    }

    func sync(accountID: UUID) async {
        guard syncingAccountID == nil else { return }
        guard accounts.contains(where: { $0.id == accountID && $0.isConnected }) else { return }
        syncingAccountID = accountID
        defer {
            if syncingAccountID == accountID {
                syncingAccountID = nil
            }
        }

        do {
            try await Task.sleep(nanoseconds: syncDelayNanoseconds)
        } catch {
            return
        }

        guard let index = accounts.firstIndex(where: { $0.id == accountID }) else { return }
        accounts[index].lastSyncedAt = Date()
    }

    static func demo(syncDelayNanoseconds: UInt64 = 650_000_000) -> ExpenseStore {
        let groceriesID = UUID(uuidString: "A1000000-0000-0000-0000-000000000001")!
        let restaurantsID = UUID(uuidString: "A1000000-0000-0000-0000-000000000002")!
        let transportID = UUID(uuidString: "A1000000-0000-0000-0000-000000000003")!

        return ExpenseStore(
            categories: [
                BudgetCategory(id: groceriesID, name: "Groceries", spentMinor: 31_240, budgetMinor: 45_000, currency: "EUR"),
                BudgetCategory(id: restaurantsID, name: "Restaurants", spentMinor: 12_780, budgetMinor: 20_000, currency: "EUR"),
                BudgetCategory(id: transportID, name: "Transport", spentMinor: 9_450, budgetMinor: 15_000, currency: "EUR"),
            ],
            accounts: [
                ExpenseAccount(id: UUID(), name: "Main account", balanceMinor: 284_350, currency: "EUR", isConnected: true, lastSyncedAt: nil),
                ExpenseAccount(id: UUID(), name: "Savings", balanceMinor: 1_250_000, currency: "EUR", isConnected: true, lastSyncedAt: Date().addingTimeInterval(-86_400)),
            ],
            candidates: [
                BankImportCandidate(id: UUID(), accountName: "Main account", date: Date().addingTimeInterval(-3_600), amountMinor: 2_745, currency: "EUR", payee: "Local Market", categoryID: groceriesID, note: "Card purchase"),
                BankImportCandidate(id: UUID(), accountName: "Main account", date: Date().addingTimeInterval(-86_400), amountMinor: 1_890, currency: "EUR", payee: "Metro", categoryID: transportID, note: nil),
            ],
            yearSpendingGoalMinor: 3_600_000,
            syncDelayNanoseconds: syncDelayNanoseconds
        )
    }
}
