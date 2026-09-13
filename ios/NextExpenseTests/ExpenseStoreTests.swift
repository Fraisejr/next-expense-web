import XCTest
@testable import NextExpense

@MainActor
final class ExpenseStoreTests: XCTestCase {
    func testBudgetProgressCapsAtOneAndTracksOverspend() {
        let category = BudgetCategory(
            id: UUID(),
            name: "Food",
            spentMinor: 12_500,
            budgetMinor: 10_000,
            currency: "EUR"
        )

        XCTAssertEqual(category.progress, 1)
        XCTAssertEqual(category.remainingMinor, -2_500)
        XCTAssertTrue(category.isOverBudget)
    }

    func testApproveRemovesCandidateFromInbox() async throws {
        let store = ExpenseStore.demo()
        let candidate = try XCTUnwrap(store.candidates.first)
        let category = try XCTUnwrap(store.categories.first)

        try await store.approve(
            candidateID: candidate.id,
            payee: candidate.payee,
            categoryID: category.id,
            rememberCategory: true
        )

        XCTAssertFalse(store.candidates.contains { $0.id == candidate.id })
    }

    func testApproveAddsExpenseToSelectedCategory() async throws {
        let store = ExpenseStore.demo()
        let candidate = try XCTUnwrap(store.candidates.first)
        let category = try XCTUnwrap(store.categories.first)

        try await store.approve(
            candidateID: candidate.id,
            payee: candidate.payee,
            categoryID: category.id,
            rememberCategory: false
        )

        let updatedCategory = try XCTUnwrap(store.categories.first { $0.id == category.id })
        XCTAssertEqual(updatedCategory.spentMinor, category.spentMinor + candidate.amountMinor)
    }

    func testApproveRequiresPayee() async throws {
        let store = ExpenseStore.demo()
        let candidate = try XCTUnwrap(store.candidates.first)
        let category = try XCTUnwrap(store.categories.first)

        do {
            try await store.approve(
                candidateID: candidate.id,
                payee: "   ",
                categoryID: category.id,
                rememberCategory: false
            )
            XCTFail("Approval should reject an empty payee")
        } catch {
            XCTAssertEqual(error as? ExpenseStore.StoreError, .missingPayee)
        }
    }

    func testRejectRemovesCandidateFromInbox() throws {
        let store = ExpenseStore.demo()
        let candidate = try XCTUnwrap(store.candidates.first)

        store.reject(candidateID: candidate.id)

        XCTAssertFalse(store.candidates.contains { $0.id == candidate.id })
    }

    func testSyncUpdatesLastSyncedDate() async throws {
        let store = ExpenseStore.demo(syncDelayNanoseconds: 0)
        let account = try XCTUnwrap(store.accounts.first)
        XCTAssertNil(account.lastSyncedAt)

        await store.sync(accountID: account.id)

        XCTAssertNotNil(store.accounts.first { $0.id == account.id }?.lastSyncedAt)
        XCTAssertNil(store.syncingAccountID)
    }
}
