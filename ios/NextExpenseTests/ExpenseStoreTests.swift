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
            categoryID: category.id
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
            categoryID: category.id
        )

        let updatedCategory = try XCTUnwrap(store.categories.first { $0.id == category.id })
        XCTAssertEqual(updatedCategory.spentMinor, category.spentMinor + candidate.amountMinor)
    }

    func testApproveRetainsEditedPayeeAndCategory() async throws {
        let store = ExpenseStore.demo()
        let candidate = try XCTUnwrap(store.candidates.first)
        let category = try XCTUnwrap(store.categories.last)

        try await store.approve(
            candidateID: candidate.id,
            payee: "Edited payee",
            categoryID: category.id
        )

        let approved = try XCTUnwrap(store.approvedTransactions.last)
        XCTAssertEqual(approved.payee, "Edited payee")
        XCTAssertEqual(approved.categoryID, category.id)
    }

    func testApproveRequiresPayee() async throws {
        let store = ExpenseStore.demo()
        let candidate = try XCTUnwrap(store.candidates.first)
        let category = try XCTUnwrap(store.categories.first)

        do {
            try await store.approve(
                candidateID: candidate.id,
                payee: "   ",
                categoryID: category.id
            )
            XCTFail("Approval should reject an empty payee")
        } catch {
            XCTAssertEqual(error as? ExpenseStore.StoreError, .missingPayee)
        }
    }

    func testApproveRequiresCategory() async throws {
        let store = ExpenseStore.demo()
        let candidate = try XCTUnwrap(store.candidates.first)

        do {
            try await store.approve(
                candidateID: candidate.id,
                payee: candidate.payee,
                categoryID: nil
            )
            XCTFail("Approval should reject a missing category")
        } catch {
            XCTAssertEqual(error as? ExpenseStore.StoreError, .missingCategory)
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

    func testSyncIgnoresOverlappingRequest() async throws {
        let store = ExpenseStore.demo(syncDelayNanoseconds: 20_000_000)
        let firstAccount = try XCTUnwrap(store.accounts.first)
        let secondAccount = try XCTUnwrap(store.accounts.last)

        let firstSync = Task { await store.sync(accountID: firstAccount.id) }
        await Task.yield()
        await store.sync(accountID: secondAccount.id)
        await firstSync.value

        XCTAssertNotNil(store.accounts.first { $0.id == firstAccount.id }?.lastSyncedAt)
        XCTAssertEqual(
            store.accounts.first { $0.id == secondAccount.id }?.lastSyncedAt,
            secondAccount.lastSyncedAt
        )
        XCTAssertNil(store.syncingAccountID)
    }
}
