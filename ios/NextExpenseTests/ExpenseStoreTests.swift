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

private final class MemoryVault: SessionVault {
    var saved: Data?
    func read() throws -> Data? { saved }
    func write(_ data: Data?) throws { saved = data }
}

private final class MockNeonProtocol: URLProtocol {
    static var respond: ((URLRequest) throws -> (Int, [String: String], Any))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, headers, object) = try Self.respond!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@MainActor
final class LiveReviewTests: XCTestCase {
    private let workspace = UUID(uuidString: "10000000-0000-0000-0000-000000000001")!
    private let candidate = UUID(uuidString: "10000000-0000-0000-0000-000000000002")!
    private let category = UUID(uuidString: "10000000-0000-0000-0000-000000000003")!
    private let account = UUID(uuidString: "10000000-0000-0000-0000-000000000004")!
    private let transaction = UUID(uuidString: "10000000-0000-0000-0000-000000000005")!
    private var requests: [URLRequest] = []
    private var approvalStatus = 200
    private var ledgerFails = false
    private var expiredOnce = false
    private var sessionCalls = 0
    private var rejectStatus = 200
    private var rejectRows = true
    private let vault = MemoryVault()

    private func makeAPI() -> NeonAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockNeonProtocol.self]
        configuration.httpShouldSetCookies = false
        MockNeonProtocol.respond = { [self] request in
            requests.append(request)
            let path = request.url!.lastPathComponent
            if path == "email" {
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                return (200, ["Set-Cookie": "session=test-session; Path=/; Secure; HttpOnly; Max-Age=86400"], ["user": ["id": "user"]])
            }
            if path == "get-session" {
                sessionCalls += 1
                XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=test-session")
                return (200, ["set-auth-jwt": "data-jwt"], ["session": ["id": "session"]])
            }
            if path == "sign-out" { return (200, [:], ["success": true]) }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer data-jwt")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"), "Auth cookies must never go to the Data API")
            if expiredOnce { expiredOnce = false; return (401, [:], ["message": "Expired token"]) }
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems ?? []
            if !["workspaces", "workspace_members", "approve_bank_import_candidate"].contains(path) {
                XCTAssertEqual(query.first(where: { $0.name == "workspace_id" })?.value, "eq.\(workspace)")
            }
            switch path {
            case "workspace_members": return (200, [:], [["workspace_id": workspace.uuidString]])
            case "workspaces": return (200, [:], [["id": workspace.uuidString, "name": "Test workspace"]])
            case "categories": return (200, [:], [["id": category.uuidString, "name": "Food"]])
            case "payees": return (200, [:], [])
            case "accounts": return (200, [:], [["id": account.uuidString, "name": "Main"]])
            case "bank_import_candidates":
                if request.httpMethod == "PATCH" {
                    return (rejectStatus, [:], rejectStatus == 200 ? (rejectRows ? [["id": candidate.uuidString]] : []) : ["message": "Write failed"])
                }
                return (200, [:], [row(candidate)])
            case "approve_bank_import_candidate":
                return (approvalStatus, [:], approvalStatus == 200 ? transaction.uuidString : ["message": "Approval failed"])
            case "transactions":
                if ledgerFails { return (503, [:], ["message": "Temporarily unavailable"]) }
                return (200, [:], query.contains(where: { $0.name == "id" }) ? [row(transaction)] : [])
            default: XCTFail("Unexpected endpoint: \(path)"); return (404, [:], [:])
            }
        }
        return NeonAPI(session: URLSession(configuration: configuration), vault: vault)
    }
    private func row(_ id: UUID) -> [String: Any] {
        ["id": id.uuidString, "account_id": account.uuidString, "transaction_date": "2026-09-12",
         "amount_minor": 2450, "currency": "SEK", "transaction_type": "expense", "payee_name": "Market",
         "payee_id": NSNull(), "category_id": category.uuidString, "memo": NSNull()]
    }
    private func signedInStore() async -> LiveExpenseStore {
        let store = LiveExpenseStore(api: makeAPI())
        await store.signIn(email: "test@example.com", password: "test-password")
        XCTAssertTrue(store.signedIn)
        XCTAssertNil(store.errorMessage)
        XCTAssertEqual(store.candidates.count, 1)
        return store
    }
    func testSignInApproveAndReadSharedLedger() async throws {
        let store = await signedInStore()
        try await store.approve(XCTUnwrap(store.candidates.first), payeeId: nil, categoryId: category)
        XCTAssertTrue(store.candidates.isEmpty)
        XCTAssertEqual(store.ledger.first?.id, transaction)
        XCTAssertEqual(store.ledger.first?.currency, "SEK")
        XCTAssertNotNil(vault.saved)
    }
    func testFailedApprovalKeepsCandidateAndDoesNotRetryMutation() async throws {
        let store = await signedInStore()
        approvalStatus = 503
        do { try await store.approve(XCTUnwrap(store.candidates.first), payeeId: nil, categoryId: category); XCTFail("Expected failure") }
        catch { XCTAssertEqual(store.candidates.count, 1) }
        XCTAssertEqual(requests.filter { $0.url?.lastPathComponent == "approve_bank_import_candidate" }.count, 1)
        XCTAssertTrue(store.ledger.isEmpty)
    }
    func testCommittedApprovalSurvivesLedgerRefreshFailure() async throws {
        let store = await signedInStore()
        ledgerFails = true
        try await store.approve(XCTUnwrap(store.candidates.first), payeeId: nil, categoryId: category)
        XCTAssertTrue(store.candidates.isEmpty)
        XCTAssertTrue(store.errorMessage?.contains("Approval saved") == true)
    }
    func testExpiredJWTRefreshesOnceAndSessionRestoresFromVault() async throws {
        let api = makeAPI()
        try await api.signIn(email: "test@example.com", password: "test-password")
        expiredOnce = true
        let _: [WorkspaceMembership] = try await api.data("workspace_members")
        XCTAssertEqual(sessionCalls, 2)
        let restored = makeAPI()
        XCTAssertTrue(try restored.restore())
        try await restored.refreshToken()
        try await restored.signOut()
        XCTAssertNil(vault.saved)
        XCTAssertFalse(try restored.restore())
    }
    func testRejectOnlyRemovesAfterServerAcknowledgement() async throws {
        let store = await signedInStore()
        let item = try XCTUnwrap(store.candidates.first)
        rejectStatus = 503
        do { try await store.reject(item); XCTFail("Expected failure") } catch {}
        XCTAssertEqual(store.candidates.count, 1)
        rejectStatus = 200
        rejectRows = false
        do { try await store.reject(item); XCTFail("Expected stale item error") } catch {}
        XCTAssertEqual(store.candidates.count, 1)
        rejectRows = true
        try await store.reject(item)
        XCTAssertTrue(store.candidates.isEmpty)
    }
    func testMissingCategoryDoesNotWrite() async throws {
        let store = await signedInStore()
        let before = requests.count
        do { try await store.approve(XCTUnwrap(store.candidates.first), payeeId: nil, categoryId: nil); XCTFail("Expected validation") } catch {}
        XCTAssertEqual(requests.count, before)
    }
}
