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
    private let payee = UUID(uuidString: "10000000-0000-0000-0000-000000000006")!
    private let mapping = UUID(uuidString: "10000000-0000-0000-0000-000000000007")!
    private var requests: [URLRequest] = []
    private var approvalStatus = 200
    private var ledgerFails = false
    private var expiredOnce = false
    private var expiryStatus = 401
    private var sessionCalls = 0
    private var bankStatus = 200
    private var bankTransportFailure = false
    private var twoBanks = false
    private var noBanks = false
    private var bankCalls = 0
    private var rejectStatus = 200
    private var rejectRows = true
    private var matchingFixtures = false
    private var candidateHasPayee = false
    private var transferFixture = false
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
            if expiredOnce { expiredOnce = false; return (expiryStatus, [:], ["message": "JWT token has expired"]) }
            if path == "sync-import" {
                bankCalls += 1
                XCTAssertEqual(request.url?.host, "next-expense-web.vercel.app")
                XCTAssertEqual(request.httpMethod, "POST")
                var bodyData = request.httpBody ?? Data()
                if bodyData.isEmpty, let stream = request.httpBodyStream {
                    stream.open(); defer { stream.close() }
                    var bytes = [UInt8](repeating: 0, count: 1024)
                    while stream.hasBytesAvailable {
                        let count = stream.read(&bytes, maxLength: bytes.count)
                        if count <= 0 { break }; bodyData.append(bytes, count: count)
                    }
                }
                let body = try JSONSerialization.jsonObject(with: bodyData) as! [String: String]
                XCTAssertEqual(body["workspaceId"], workspace.uuidString)
                XCTAssertNotNil(body["accountId"])
                XCTAssertNil(body["providerAccountId"])
                if bankTransportFailure { throw URLError(.timedOut) }
                if bankStatus != 200 && bankCalls == 1 { return (bankStatus, [:], ["error": "Reconnect this bank on the website."]) }
                return (200, [:], ["imported": 2, "duplicates": 10, "diagnostic": ["staged": 3, "zeroIgnored": 1], "warnings": []])
            }
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems ?? []
            let unfilteredInsert = request.httpMethod == "POST" && ["payees", "payee_mappings"].contains(path)
            if unfilteredInsert {
                XCTAssertNil(query.first(where: { $0.name == "workspace_id" }), "Insert filters trigger Neon subzer0_source errors; scope belongs in the body and RLS.")
            } else if !["workspaces", "workspace_members", "approve_bank_import_candidate", "approve_bank_import_candidate_as_transfer", "workspace_account_balances"].contains(path) {
                XCTAssertEqual(query.first(where: { $0.name == "workspace_id" })?.value, "eq.\(workspace)")
            }
            switch path {
            case "workspace_members": return (200, [:], [["workspace_id": workspace.uuidString]])
            case "workspaces": return (200, [:], [["id": workspace.uuidString, "name": "Test workspace", "default_currency": "SEK", "yearly_spending_goals": [:]]])
            case "categories": return (200, [:], [["id": category.uuidString, "name": "Food", "report_group": "personal_expense"]])
            case "workspace_account_balances": return (200, [:], [["account_id": account.uuidString, "balance_minor": 10000]] + (twoBanks ? [["account_id": transaction.uuidString, "balance_minor": 20000]] : []))
            case "category_groups": return (200, [:], [])
            case "periods": return (200, [:], [])
            case "budgets": return (200, [:], [])
            case "fx_rates": return (200, [:], [])
            case "payees":
                if request.httpMethod == "POST" {
                    let body = try jsonBody(request)
                    XCTAssertEqual(body["workspace_id"] as? String, workspace.uuidString)
                    return (200, [:], [["id": body["id"]!, "name": body["name"]!, "default_category_id": body["default_category_id"] ?? NSNull()]])
                }
                return (200, [:], matchingFixtures ? [["id": payee.uuidString, "name": "Market Payee", "default_category_id": category.uuidString]] : [])
            case "payee_mappings":
                if request.httpMethod == "PATCH" { return (200, [:], [["id": mapping.uuidString, "source_name": "Market", "payee_id": payee.uuidString, "match_type": "starts_with"]]) }
                if request.httpMethod == "POST" {
                    let body = try jsonBody(request)
                    XCTAssertEqual(body["workspace_id"] as? String, workspace.uuidString)
                    return (200, [:], [["id": body["id"]!, "source_name": body["source_name"]!, "payee_id": body["payee_id"]!, "match_type": "exact"]])
                }
                return (200, [:], matchingFixtures ? [["id": mapping.uuidString, "source_name": "Market", "payee_id": payee.uuidString, "match_type": "exact"]] : [])
            case "bank_connections": return (200, [:], noBanks ? [] : ([["account_id": account.uuidString]] + (twoBanks ? [["account_id": transaction.uuidString]] : [])))
            case "accounts": return (200, [:], [["id": account.uuidString, "name": "Main", "currency": "SEK", "closed": false, "scope": "Personal"]] + (twoBanks ? [["id": transaction.uuidString, "name": "Second", "currency": "SEK", "closed": false, "scope": "Personal"]] : []))
            case "bank_import_candidates":
                if request.httpMethod == "PATCH" {
                    return (rejectStatus, [:], rejectStatus == 200 ? (rejectRows ? [["id": candidate.uuidString]] : []) : ["message": "Write failed"])
                }
                return (200, [:], [row(candidate)])
            case "approve_bank_import_candidate":
                return (approvalStatus, [:], approvalStatus == 200 ? transaction.uuidString : ["message": "Approval failed"])
            case "approve_bank_import_candidate_as_transfer":
                return (approvalStatus, [:], approvalStatus == 200 ? transaction.uuidString : ["message": "Transfer failed"])
            case "transactions":
                if query.contains(where: { $0.name == "transaction_type" && $0.value == "eq.transfer" }) {
                    return (200, [:], transferFixture ? [[
                        "id": mapping.uuidString, "account_id": account.uuidString,
                        "destination_account_id": transaction.uuidString, "transaction_date": "2026-09-11",
                        "amount_minor": 2450, "destination_amount_minor": 2450, "currency": "SEK"
                    ]] : [])
                }
                if ledgerFails { return (503, [:], ["message": "Temporarily unavailable"]) }
                return (200, [:], query.contains(where: { $0.name == "id" }) ? [row(transaction)] : [])
            default: XCTFail("Unexpected endpoint: \(path)"); return (404, [:], [:])
            }
        }
        return NeonAPI(session: URLSession(configuration: configuration), vault: vault)
    }

    private func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                data.append(bytes, count: count)
            }
        }
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
    func testBudgetLoadsWithReadOnlyMonthScopedRequests() async {
        let store = await signedInStore()
        XCTAssertNotNil(store.budget)
        XCTAssertNil(store.budgetError)
        XCTAssertEqual(store.budget?.month, String(LiveReports.today().prefix(7)))
        let budgetTables = ["category_groups", "categories", "periods", "budgets", "transactions", "fx_rates"]
        for request in requests where budgetTables.contains(request.url?.lastPathComponent ?? "") {
            XCTAssertEqual(request.httpMethod, "GET")
        }
        let monthly = requests.filter { request in
            request.url?.lastPathComponent == "transactions" && (URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []).contains { $0.name == "and" && ($0.value ?? "").contains("transaction_date.lt.") }
        }
        XCTAssertEqual(monthly.count, 1)
    }

    func testBankSyncRefreshesReportsAndReviewAndUsesOnlyJWT() async throws {
        let store = await signedInStore()
        let before = requests.filter { $0.url?.lastPathComponent == "workspace_account_balances" }.count
        await store.syncBanks()
        XCTAssertEqual(bankCalls, 1)
        XCTAssertEqual(store.bankSyncResults.count, 1)
        XCTAssertTrue(store.bankSyncResults[0].message.contains("3 to review"))
        XCTAssertFalse(store.bankSyncResults[0].failed)
        XCTAssertNotNil(store.reports)
        XCTAssertEqual(requests.filter { $0.url?.lastPathComponent == "workspace_account_balances" }.count, before + 1)
        XCTAssertFalse(store.busy)
    }

    func testBankSyncContinuesAfterAnAccountFailure() async throws {
        twoBanks = true; bankStatus = 403
        let store = await signedInStore()
        await store.syncBanks()
        XCTAssertEqual(bankCalls, 2)
        XCTAssertTrue(store.bankSyncResults[0].failed)
        XCTAssertEqual(store.bankSyncResults[0].message, "Reconnect this bank on the website.")
        XCTAssertFalse(store.bankSyncResults[1].failed)
        XCTAssertNotNil(store.reports)
    }

    func testBankTransportFailureIsNotRetriedAndStillRefreshes() async throws {
        bankTransportFailure = true
        let store = await signedInStore()
        await store.syncBanks()
        XCTAssertEqual(bankCalls, 1)
        XCTAssertTrue(store.bankSyncResults[0].failed)
        XCTAssertNotNil(store.reports)
    }

    func testNoConnectedBanksDoesNotCallProvider() async throws {
        noBanks = true
        let store = await signedInStore()
        await store.syncBanks()
        XCTAssertEqual(bankCalls, 0)
        XCTAssertTrue(store.notice?.contains("No connected banks") == true)
    }

    func testNeon400ExpiryRenewsInsteadOfFailing() async throws {
        let api = makeAPI()
        try await api.signIn(email: "test@example.com", password: "fixture")
        expiredOnce = true
        expiryStatus = 400
        let _: [[String: String]] = try await api.data("workspace_members")
        XCTAssertEqual(sessionCalls, 2)
        XCTAssertEqual(requests.filter { $0.url?.lastPathComponent == "workspace_members" }.count, 2)
    }

    func testJWTExpiryHintAndNonAuthErrors() throws {
        let data = try JSONSerialization.data(withJSONObject: ["exp": 1000])
        let payload = data.base64EncodedString().replacingOccurrences(of: "=", with: "")
        let token = "header." + payload + ".signature"
        XCTAssertTrue(NeonAPI.expiresSoon(token, now: Date(timeIntervalSince1970: 980)))
        XCTAssertFalse(NeonAPI.expiresSoon(token, now: Date(timeIntervalSince1970: 900)))
        XCTAssertFalse(MobileAPIError(message: "Invalid amount", status: 400).isExpiredJWT)
        XCTAssertFalse(MobileAPIError(message: "JWT token has expired", status: 500).isExpiredJWT)
    }

    private func row(_ id: UUID) -> [String: Any] {
        ["id": id.uuidString, "account_id": account.uuidString, "transaction_date": "2026-09-12",
         "amount_minor": 2450, "currency": "SEK", "transaction_type": "expense", "payee_name": "Market",
         "payee_id": candidateHasPayee ? payee.uuidString as Any : NSNull() as Any, "category_id": category.uuidString,
         "memo": matchingFixtures ? "Market Barcelona purchase" : NSNull()]
    }
    private func signedInStore() async -> LiveExpenseStore {
        let store = LiveExpenseStore(api: makeAPI())
        await store.signIn(email: "test@example.com", password: "test-password")
        XCTAssertTrue(store.signedIn)
        XCTAssertNil(store.errorMessage)
        XCTAssertEqual(store.candidates.count, 1)
        return store
    }
    func testSignInApproveAndRefreshReports() async throws {
        let store = await signedInStore()
        try await store.approve(XCTUnwrap(store.candidates.first), payeeId: nil, categoryId: category)
        XCTAssertTrue(store.candidates.isEmpty)
        XCTAssertEqual(store.reports?.netWorth, 10000)
        XCTAssertEqual(store.reports?.currency, "SEK")
        XCTAssertNotNil(vault.saved)
    }
    func testFailedApprovalKeepsCandidateAndDoesNotRetryMutation() async throws {
        let store = await signedInStore()
        approvalStatus = 503
        do { try await store.approve(XCTUnwrap(store.candidates.first), payeeId: nil, categoryId: category); XCTFail("Expected failure") }
        catch { XCTAssertEqual(store.candidates.count, 1) }
        XCTAssertEqual(requests.filter { $0.url?.lastPathComponent == "approve_bank_import_candidate" }.count, 1)
        XCTAssertNotNil(store.reports)
    }
    func testCommittedApprovalSurvivesReportRefreshFailure() async throws {
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

    func testSwipeApprovalAcceptsImportedOrSavedPayeeWithCategory() async throws {
        matchingFixtures = true
        var store = await signedInStore()
        let importedPayee = try XCTUnwrap(store.candidates.first)
        XCTAssertTrue(store.canSwipeApprove(importedPayee))

        let missingCategory = ReviewTransaction(
            id: importedPayee.id, accountId: importedPayee.accountId, transactionDate: importedPayee.transactionDate,
            amountMinor: importedPayee.amountMinor, currency: importedPayee.currency, transactionType: importedPayee.transactionType,
            payeeName: importedPayee.payeeName, payeeId: nil, categoryId: nil, memo: importedPayee.memo
        )
        XCTAssertFalse(store.canSwipeApprove(missingCategory))

        candidateHasPayee = true
        store = await signedInStore()
        XCTAssertTrue(store.canSwipeApprove(try XCTUnwrap(store.candidates.first)))
    }

    func testPossiblePrefixMatchCanBePromotedOrSavedAsAlternative() async throws {
        matchingFixtures = true
        let store = await signedInStore()
        let item = try XCTUnwrap(store.candidates.first)
        let suggestion = try XCTUnwrap(store.possiblePayeeMatch(for: item))
        XCTAssertEqual(suggestion.payee.name, "Market Payee")
        XCTAssertEqual(suggestion.mapping.sourceName, "Market")
        XCTAssertTrue(suggestion.sourceIsMemo)

        try await store.promotePayeeMapping(suggestion)
        XCTAssertEqual(store.payeeMappings.first?.matchType, "starts_with")
        XCTAssertEqual(requests.filter { $0.url?.lastPathComponent == "payee_mappings" && $0.httpMethod == "PATCH" }.count, 1)

        try await store.addAlternativeName(suggestion.sourceText, payee: suggestion.payee, accountId: account)
        XCTAssertTrue(store.payeeMappings.contains { $0.sourceName == "Market Barcelona purchase" && $0.payeeId == payee })
        XCTAssertEqual(store.candidates.first?.payeeId, payee)
        XCTAssertEqual(store.candidates.first?.categoryId, category)
        XCTAssertEqual(requests.filter { $0.url?.lastPathComponent == "payee_mappings" && $0.httpMethod == "POST" }.count, 1)
    }

    func testCreatesPayeeAndRemembersCategoryAndAlternativeOnApproval() async throws {
        let store = await signedInStore()
        let created = try await store.createPayee(name: "New Market", categoryId: category, accountId: account)
        XCTAssertEqual(created.name, "New Market")
        XCTAssertEqual(created.defaultCategoryId, category)

        let item = try XCTUnwrap(store.candidates.first)
        try await store.approve(item, payeeId: created.id, categoryId: category, rememberCategory: true, rememberMapping: true)
        let approval = try XCTUnwrap(requests.last(where: { $0.url?.lastPathComponent == "approve_bank_import_candidate" }))
        let approvalBody = try jsonBody(approval)
        XCTAssertEqual(approvalBody["p_remember_category"] as? Bool, true)
        XCTAssertTrue(store.payeeMappings.contains { $0.sourceName == "Market" && $0.payeeId == created.id })
        XCTAssertTrue(store.candidates.isEmpty)
    }

    func testSuggestsAndPostsExistingTransfer() async throws {
        twoBanks = true
        transferFixture = true
        let store = await signedInStore()
        let item = try XCTUnwrap(store.candidates.first)
        let suggested = try XCTUnwrap(store.suggestedTransferAccount(for: item))
        XCTAssertEqual(suggested.id, transaction)

        try await store.approveAsTransfer(item, counterpartyAccountId: suggested.id)
        let request = try XCTUnwrap(requests.last(where: { $0.url?.lastPathComponent == "approve_bank_import_candidate_as_transfer" }))
        let body = try jsonBody(request)
        XCTAssertEqual(body["p_counterparty_account_id"] as? String, transaction.uuidString)
        XCTAssertTrue(store.candidates.isEmpty)
    }
}

@MainActor
private final class MockGoogleBrowser: GoogleAuthenticating {
    var callback: (() -> URL)!
    func authenticate(_ url: URL, callbackScheme: String) async throws -> URL {
        XCTAssertEqual(url.host, "accounts.google.com")
        XCTAssertEqual(callbackScheme, GoogleSignInAttempt.scheme)
        return callback()
    }
}

@MainActor
final class GoogleSignInTests: XCTestCase {
    func testRejectedCallbackReportsSetupProblemWithoutOpeningGoogle() async throws {
        let vault = MemoryVault()
        let options = URLSessionConfiguration.ephemeral
        options.protocolClasses = [MockNeonProtocol.self]
        MockNeonProtocol.respond = { request in
            XCTAssertEqual(request.url?.lastPathComponent, "social")
            return (403, [:], ["code": "INVALID_CALLBACKURL"])
        }
        let api = NeonAPI(session: URLSession(configuration: options), vault: vault)
        let browser = MockGoogleBrowser()
        browser.callback = { XCTFail("Browser must not open after a rejected callback"); return URL(string: "https://example.com")! }
        do {
            try await api.signInWithGoogle(using: browser)
            XCTFail("Expected callback setup failure")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("do not need to create a password"))
        }
        XCTAssertNil(vault.saved)
    }

    func testCallbackRequiresMatchingStateHostAndSingleVerifier() throws {
        let attempt = GoogleSignInAttempt()
        XCTAssertEqual(attempt.callbackURL.host, "next-expense-web.vercel.app")
        XCTAssertEqual(attempt.callbackURL.path, "/auth/ios/callback")
        let good = "com.fraisejr.nextexpense://auth/callback?state=\(attempt.state)&neon_auth_session_verifier=one-time-verifier"
        XCTAssertEqual(try attempt.verifier(from: URL(string: good)!), "one-time-verifier")
        for invalid in [
            good.replacingOccurrences(of: attempt.state, with: "wrong-state"),
            good.replacingOccurrences(of: "://auth/", with: "://other/"),
            good + "&state=" + attempt.state,
            good + "&neon_auth_session_verifier=another",
            good + "&error=access_denied",
            attempt.callbackURL.absoluteString,
        ] {
            XCTAssertThrowsError(try attempt.verifier(from: URL(string: invalid)!))
        }
        XCTAssertNotEqual(attempt.state, GoogleSignInAttempt().state)
    }

    func testGoogleVerifierExchangedWithOriginalChallengeThenRestores() async throws {
        let vault = MemoryVault()
        let options = URLSessionConfiguration.ephemeral
        options.protocolClasses = [MockNeonProtocol.self]
        options.httpShouldSetCookies = false
        var returnURL: URL?
        var exchanges = 0
        MockNeonProtocol.respond = { request in
            switch request.url!.lastPathComponent {
            case "social":
                var data = request.httpBody ?? Data()
                if let stream = request.httpBodyStream {
                    stream.open(); defer { stream.close() }
                    var buffer = [UInt8](repeating: 0, count: 1024)
                    while stream.hasBytesAvailable {
                        let count = stream.read(&buffer, maxLength: buffer.count)
                        if count <= 0 { break }
                        data.append(buffer, count: count)
                    }
                }
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                XCTAssertEqual(body["provider"] as? String, "google")
                XCTAssertEqual(body["disableRedirect"] as? Bool, true)
                let callback = try XCTUnwrap(body["callbackURL"] as? String)
                XCTAssertEqual(body["errorCallbackURL"] as? String, callback)
                let relay = try XCTUnwrap(URLComponents(string: callback))
                XCTAssertEqual(relay.scheme, "https")
                XCTAssertEqual(relay.host, "next-expense-web.vercel.app")
                returnURL = URL(string: "com.fraisejr.nextexpense://auth/callback?" + (relay.percentEncodedQuery ?? "") + "&neon_auth_session_verifier=one-use-code")
                return (200, ["Set-Cookie": "neon-auth.session_challenge=challenge; Secure; Path=/; Max-Age=600"], ["url": "https://accounts.google.com/o/oauth2/v2/auth?state=provider-state"])
            case "get-session":
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                if query.contains(where: { $0.name == "neon_auth_session_verifier" }) {
                    exchanges += 1
                    XCTAssertEqual(query.first?.value, "one-use-code")
                    XCTAssertTrue(request.value(forHTTPHeaderField: "Cookie")?.contains("neon-auth.session_challenge=challenge") == true)
                } else {
                    XCTAssertTrue(request.value(forHTTPHeaderField: "Cookie")?.contains("session=restored-session") == true)
                }
                return (200, ["Set-Cookie": "session=restored-session; Secure; Path=/; Max-Age=86400", "set-auth-jwt": "google-jwt"], ["session": ["id": "same-web-user"]])
            default: XCTFail("Unexpected endpoint"); return (404, [:], [:])
            }
        }
        let api = NeonAPI(session: URLSession(configuration: options), vault: vault)
        let browser = MockGoogleBrowser()
        browser.callback = { returnURL! }
        try await api.signInWithGoogle(using: browser)
        XCTAssertEqual(exchanges, 1)
        XCTAssertNotNil(vault.saved)
        let restored = NeonAPI(session: URLSession(configuration: options), vault: vault)
        XCTAssertTrue(try restored.restore())
        try await restored.refreshToken()
        XCTAssertEqual(exchanges, 1, "One-time verifiers must not be replayed during restoration")
    }
}

@MainActor
final class LiveReportsTests: XCTestCase {
    func testNetWorthSpendingRefundsAndCurrencyMatchWebRules() throws {
        let personal = UUID(), company = UUID(), tax = UUID()
        let euro = UUID(), sek = UUID(), closed = UUID()
        let accounts = [
            ReportAccount(id: euro, name: "Cash", currency: "EUR", closed: false, scope: "Personal", balanceSheetGroup: "Personal", pension: false),
            ReportAccount(id: sek, name: "Loan", currency: "SEK", closed: false, scope: "Company", balanceSheetGroup: "Company", pension: false),
            ReportAccount(id: closed, name: "Closed", currency: "EUR", closed: true, scope: "Personal", balanceSheetGroup: nil, pension: false)
        ]
        let balances = [ReportBalance(accountId: euro, balanceMinor: 100000), ReportBalance(accountId: sek, balanceMinor: -200000), ReportBalance(accountId: closed, balanceMinor: 900000)]
        let categories = [ReportCategory(id: personal, reportGroup: "personal_expense"), ReportCategory(id: company, reportGroup: "company_expense"), ReportCategory(id: tax, reportGroup: "personal_tax")]
        func item(_ amount: Int, _ currency: String, _ type: String, _ category: UUID, _ date: String = "2026-06-15") -> ReportActivity {
            ReportActivity(transactionDate: date, amountMinor: amount, currency: currency, transactionType: type, categoryId: category)
        }
        let activity = [item(10000, "EUR", "expense", personal), item(2000, "EUR", "income", personal), item(50000, "SEK", "expense", company), item(9000, "EUR", "expense", tax), item(99000, "EUR", "transfer", personal), item(999, "EUR", "expense", personal, "2025-12-31"), item(999, "EUR", "expense", personal, "2026-10-01")]
        let rates = [ReportRate(baseCurrency: "EUR", quoteCurrency: "SEK", rateHundredths: 1000, rateDate: "2026-06-30"), ReportRate(baseCurrency: "EUR", quoteCurrency: "SEK", rateHundredths: 2000, rateDate: "2026-10-01")]
        var plan = ReportPlan(); plan.personalSpendingMinor = 100000; plan.companySpendingMinor = 50000
        let config = ReportWorkspace(defaultCurrency: "EUR", yearlySpendingGoals: ["2026": plan])
        let report = try LiveReports.calculate(config: config, accounts: accounts, balances: balances, categories: categories, activity: activity, rates: rates, today: "2026-09-13")
        XCTAssertEqual(report.netWorth, 80000)
        XCTAssertEqual(report.assets, 100000)
        XCTAssertEqual(report.liabilities, 20000)
        XCTAssertEqual(report.expenses, 13000)
        XCTAssertEqual(report.personalExpenses, 8000)
        XCTAssertEqual(report.companyExpenses, 5000)
        XCTAssertEqual(report.goal, 150000)
        XCTAssertThrowsError(try LiveReports.calculate(config: config, accounts: accounts, balances: balances, categories: categories, activity: activity, rates: [], today: "2026-09-13"))
        XCTAssertThrowsError(try LiveReports.calculate(config: config, accounts: accounts, balances: [], categories: categories, activity: activity, rates: rates, today: "2026-09-13"))
    }
    func testMissingZeroAndLegacyGoalsAreDistinct() {
        var plan = ReportPlan()
        XCTAssertNil(plan.combinedGoal)
        plan.companySpendingMinor = 0; plan.personalSpendingMinor = 0
        XCTAssertEqual(plan.combinedGoal, 0)
        plan.personalSpendingMinor = nil; plan.companySpendingMinor = 20000
        plan.projectedIncomeMinor = 100000; plan.projectedTaxesMinor = 10000; plan.savingsGoalMinor = 30000
        XCTAssertEqual(plan.combinedGoal, 60000)
    }
}

final class SpendingPaceTests: XCTestCase {
    func testPaceUsesCalendarDaysIncludingToday() throws {
        let first = try XCTUnwrap(SpendingPace(throughDate: "2026-01-01", annualGoal: 365000, expenses: 1500))
        XCTAssertEqual(first.elapsedDays, 1)
        XCTAssertEqual(first.daysInYear, 365)
        XCTAssertEqual(first.target, 1000)
        XCTAssertEqual(first.variance, 500)
        let end = try XCTUnwrap(SpendingPace(throughDate: "2026-12-31", annualGoal: 365000, expenses: 350000))
        XCTAssertEqual(end.target, 365000)
        XCTAssertEqual(end.variance, -15000)
    }
    func testLeapYearAndZeroGoal() throws {
        let leap = try XCTUnwrap(SpendingPace(throughDate: "2024-02-29", annualGoal: 366000, expenses: 60000))
        XCTAssertEqual(leap.daysInYear, 366)
        XCTAssertEqual(leap.elapsedDays, 60)
        XCTAssertEqual(leap.target, 60000)
        XCTAssertEqual(leap.variance, 0)
        let zero = try XCTUnwrap(SpendingPace(throughDate: "2026-09-13", annualGoal: 0, expenses: 500))
        XCTAssertEqual(zero.target, 0)
        XCTAssertEqual(zero.variance, 500)
        XCTAssertNil(SpendingPace(throughDate: "invalid", annualGoal: 100, expenses: 0))
    }
}

@MainActor
final class LiveBudgetTests: XCTestCase {
    func testMonthlySpendingRefundsIncomeAndOverridesMatchWeb() throws {
        let food = UUID(), salary = UUID(), group = UUID(), account = UUID()
        let categories = [
            MobileBudgetCategory(id: food, name: "Groceries", categoryGroupId: group, sortOrder: 2, defaultBudgetMinor: 20000, color: "#ff0000", icon: "basket", reportGroup: "personal_expense", hidden: false),
            MobileBudgetCategory(id: salary, name: "Salary", categoryGroupId: nil, sortOrder: 1, defaultBudgetMinor: 100000, color: nil, icon: "briefcase.fill", reportGroup: "personal_income", hidden: false)
        ]
        func transaction(_ category: UUID, _ amount: Int, _ type: String, _ date: String = "2026-09-10", _ currency: String = "EUR") -> ReviewTransaction {
            ReviewTransaction(id: UUID(), accountId: account, transactionDate: date, amountMinor: amount, currency: currency, transactionType: type, payeeName: "Payee", payeeId: nil, categoryId: category, memo: nil)
        }
        let activity = [transaction(food, 10000, "expense"), transaction(food, 2000, "income"), transaction(food, 50000, "expense", "2026-09-12", "SEK"), transaction(food, 99999, "expense", "2026-08-31"), transaction(food, 99999, "expense", "2026-10-01"), transaction(food, 99999, "transfer"), transaction(salary, 100000, "income"), transaction(salary, 5000, "expense")]
        let rates = [ReportRate(baseCurrency: "EUR", quoteCurrency: "SEK", rateHundredths: 1000, rateDate: "2026-09-30")]
        let result = try LiveBudget.calculate(month: "2026-09", currency: "EUR", groups: [MobileBudgetGroup(id: group, name: "Everyday", sortOrder: 0)], categories: categories, overrides: [MobileBudgetOverride(categoryId: food, amountMinor: 0)], activity: activity, rates: rates)
        let foodRow = result.groups[0].categories[0]
        XCTAssertEqual(foodRow.spent, 13000)
        XCTAssertEqual(foodRow.budget, 0, "An explicit zero overrides the default")
        XCTAssertEqual(foodRow.transactions.count, 3, "Drill-down contains exactly this month's non-transfer activity")
        XCTAssertEqual(foodRow.transactions.first?.transactionDate, "2026-09-12")
        XCTAssertEqual(result.groups[1].name, "Other")
        XCTAssertEqual(result.groups[1].categories[0].spent, 95000)
        XCTAssertEqual(result.groups[1].categories[0].budget, 100000)
        XCTAssertEqual(categories[0].symbol, "cart.fill")
        XCTAssertEqual(categories[1].symbol, "briefcase.fill")
        XCTAssertEqual(LiveBudget.nextMonth("2026-12"), "2027-01")
    }

    func testGroupsCategoryOrderHiddenRowsAndOverBudgetProgress() throws {
        let first = UUID(), second = UUID()
        func category(_ name: String, _ group: UUID?, _ order: Int, _ hidden: Bool = false) -> MobileBudgetCategory {
            MobileBudgetCategory(id: UUID(), name: name, categoryGroupId: group, sortOrder: order, defaultBudgetMinor: 1000, color: nil, icon: nil, reportGroup: "personal_expense", hidden: hidden)
        }
        let a = category("Last", first, 2), b = category("First", first, 1, true), c = category("Ungrouped", UUID(), 0)
        let result = try LiveBudget.calculate(month: "2026-09", currency: "EUR", groups: [MobileBudgetGroup(id: second, name: "Empty", sortOrder: 0), MobileBudgetGroup(id: first, name: "Expenses", sortOrder: 1)], categories: [a, b, c], overrides: [], activity: [], rates: [])
        XCTAssertEqual(result.groups.map { $0.name }, ["Expenses", "Other"])
        XCTAssertEqual(result.groups[0].categories.map { $0.category.name }, ["First", "Last"])
        XCTAssertEqual(result.groups[0].categories[0].category.hidden, true)
        let overspent = LiveBudget.Category(category: a, spent: 1500, budget: 1000, transactions: [])
        XCTAssertEqual(overspent.fraction, 1.5, "Show the true percentage even when the bar is full")
    }
}
