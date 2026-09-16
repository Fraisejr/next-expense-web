import AuthenticationServices
import Combine
import Foundation

struct WorkspaceMembership: Decodable { let workspaceId: UUID }
struct ReviewWorkspace: Decodable, Identifiable { let id: UUID; let name: String }
struct ReviewChoice: Decodable, Identifiable, Hashable { let id: UUID; let name: String }
struct ReviewPayee: Decodable, Identifiable, Hashable {
    let id: UUID
    let name: String
    let defaultCategoryId: UUID?
}
struct ReviewAccount: Decodable, Identifiable, Hashable {
    let id: UUID
    let name: String
    let currency: String
    let closed: Bool
}
struct ReviewPayeeMapping: Decodable, Identifiable, Hashable {
    let id: UUID
    let sourceName: String
    let payeeId: UUID
    let matchType: String
}
struct ReviewPayeeSuggestion: Equatable {
    let mapping: ReviewPayeeMapping
    let payee: ReviewPayee
    let sourceText: String
    let sourceIsMemo: Bool
}
enum ReviewReadiness: Equatable {
    case ready
    case missingPayee
    case missingCategory
    case missingPayeeAndCategory
}
struct ReviewTransaction: Decodable, Identifiable {
    let id: UUID
    let accountId: UUID
    let transactionDate: String
    let amountMinor: Int
    let currency: String
    let transactionType: String
    let payeeName: String?
    let payeeId: UUID?
    let categoryId: UUID?
    let memo: String?
}
struct ReviewTransfer: Decodable, Identifiable {
    let id: UUID
    let accountId: UUID
    let destinationAccountId: UUID?
    let transactionDate: String
    let amountMinor: Int
    let destinationAmountMinor: Int?
    let currency: String
}

struct MobileBankSyncSummary: Decodable {
    struct Diagnostic: Decodable { let staged: Int; let zeroIgnored: Int? }
    let imported: Int
    let duplicates: Int
    let diagnostic: Diagnostic
    let warnings: [String]
}
struct MobileBankSyncResult: Identifiable {
    let id: UUID
    let name: String
    var message: String
    var failed = false
}

@MainActor
final class LiveExpenseStore: ObservableObject {
    @Published private(set) var signedIn = false
    @Published private(set) var busy = false
    @Published private(set) var workspaces: [ReviewWorkspace] = []
    @Published private(set) var workspace: ReviewWorkspace?
    @Published private(set) var candidates: [ReviewTransaction] = []
    @Published private(set) var reports: LiveReports?
    @Published private(set) var budget: LiveBudget?
    @Published private(set) var budgetError: String?
    @Published private(set) var categories: [ReviewChoice] = []
    @Published private(set) var payees: [ReviewPayee] = []
    @Published private(set) var payeeMappings: [ReviewPayeeMapping] = []
    @Published private(set) var accounts: [ReviewAccount] = []
    @Published private(set) var reviewTransfers: [ReviewTransfer] = []
    @Published var errorMessage: String?
    @Published var notice: String?
    @Published private(set) var bankSyncResults: [MobileBankSyncResult] = []
    @Published private(set) var syncingBanks = false
    private let api: NeonAPI
    private let columns = "id,account_id,transaction_date,amount_minor,currency,transaction_type,payee_name,payee_id,category_id,memo"

    init(api: NeonAPI? = nil) { self.api = api ?? NeonAPI() }

    func restore() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard try api.restore() else { return }
            try await api.refreshToken()
            signedIn = true
            try await loadWorkspaces()
        } catch { handle(error) }
    }

    func signIn(email: String, password: String) async {
        guard !busy else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await api.signIn(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            signedIn = true
            try await loadWorkspaces()
        } catch { handle(error) }
    }

    func signInWithGoogle() async {
        guard !busy else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            try await api.signInWithGoogle(using: GoogleAuthenticationBrowser())
            signedIn = true
            try await loadWorkspaces()
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            // Closing the system sign-in sheet is a normal cancellation.
        } catch { handle(error) }
    }

    func signOut() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { try await api.signOut(); errorMessage = nil }
        catch { errorMessage = "Signed out on this device. Server sign-out failed: \(error.localizedDescription)" }
        reset()
    }

    func select(_ workspace: ReviewWorkspace) async {
        guard !busy else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        clearWorkspace()
        self.workspace = workspace
        do { try await loadSnapshot(workspace.id) } catch { handle(error) }
    }

    func refresh() async {
        guard !busy else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            if let workspace { try await loadSnapshot(workspace.id) }
            else { try await loadWorkspaces() }
        } catch { handle(error) }
    }

    func syncBanks() async {
        guard !busy, let workspace else { return }
        busy = true; syncingBanks = true; errorMessage = nil; notice = nil; bankSyncResults = []
        defer { busy = false; syncingBanks = false }
        struct Connection: Decodable { let accountId: UUID }
        do {
            let connections: [Connection] = try await all("bank_connections", query: scoped(workspace.id) + [
                .init(name: "select", value: "account_id"), .init(name: "account_id", value: "not.is.null"), .init(name: "provider", value: "eq.gocardless_bank_account_data"),
                .init(name: "status", value: "eq.active"), .init(name: "order", value: "id")
            ])
            let openAccounts: [ReviewChoice] = try await all("accounts", query: scoped(workspace.id) + [
                .init(name: "select", value: "id,name"), .init(name: "closed", value: "eq.false"), .init(name: "order", value: "name,id")
            ])
            let connected = Set(connections.map { $0.accountId })
            let targets = openAccounts.filter { connected.contains($0.id) }
            guard !targets.isEmpty else { notice = "No connected banks. Connect an account on the website first."; return }
            bankSyncResults = targets.map { .init(id: $0.id, name: $0.name, message: "Waiting") }
            for (index, account) in targets.enumerated() {
                bankSyncResults[index].message = "Syncing…"
                do {
                    let result = try await api.syncBank(workspaceId: workspace.id, accountId: account.id)
                    let summary = "\(result.imported) imported · \(result.diagnostic.staged) to review · \(result.duplicates) already known"
                    bankSyncResults[index].message = ([summary] + result.warnings).joined(separator: "\n")
                    bankSyncResults[index].failed = !result.warnings.isEmpty
                } catch {
                    bankSyncResults[index].message = error.localizedDescription
                    bankSyncResults[index].failed = true
                    if let failure = error as? MobileAPIError, failure.status == 401 {
                        for remaining in targets.indices where remaining > index {
                            bankSyncResults[remaining].message = "Not synced — sign in again."
                            bankSyncResults[remaining].failed = true
                        }
                        break
                    }
                }
            }
            // Refresh even after partial failures: earlier accounts may have saved.
            do { try await loadSnapshot(workspace.id) }
            catch { errorMessage = "Bank sync finished. Could not refresh Reports and Review: \(error.localizedDescription)" }
        } catch { handle(error) }
    }

    func approve(_ candidate: ReviewTransaction, payeeId: UUID?, categoryId: UUID?, rememberCategory: Bool = false, rememberMapping: Bool = false) async throws {
        guard !busy, let workspace else { throw MobileAPIError(message: "Wait for the current request to finish.", status: 0) }
        guard let categoryId, categories.contains(where: { $0.id == categoryId }) else {
            throw MobileAPIError(message: "Choose an active category.", status: 0)
        }
        guard payeeId == nil || payees.contains(where: { $0.id == payeeId }) else {
            throw MobileAPIError(message: "Choose an available payee.", status: 0)
        }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            var resolvedPayee = payeeId.flatMap { id in payees.first(where: { $0.id == id }) }
            var createdPayee = false
            if resolvedPayee == nil {
                let importedName = candidate.payeeName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !importedName.isEmpty else { throw MobileAPIError(message: "Choose or create a payee before approving.", status: 0) }
                resolvedPayee = payees.first(where: { Self.normalizedPayeeName($0.name) == Self.normalizedPayeeName(importedName) })
                if resolvedPayee == nil {
                    resolvedPayee = try await insertPayee(name: importedName, categoryId: categoryId, accountId: candidate.accountId)
                    createdPayee = true
                }
            }
            guard let resolvedPayee else { throw MobileAPIError(message: "Choose or create a payee before approving.", status: 0) }
            // Same two-step flow as the web app. Only change the payee if edited,
            // so retrying an approval whose response was lost reaches the idempotent RPC.
            if resolvedPayee.id != candidate.payeeId {
                let rows: [ReviewID] = try await api.data("bank_import_candidates", query: scoped(workspace.id) + [
                    .init(name: "id", value: "eq.\(candidate.id)"), .init(name: "status", value: "eq.pending"), .init(name: "select", value: "id")
                ], method: "PATCH", body: ["payee_id": resolvedPayee.id.uuidString])
                if rows.isEmpty {
                    // An earlier attempt may already have committed. The RPC verifies status.
                    notice = "Checking whether this transaction was already approved."
                }
            }
            let _: UUID = try await api.data("rpc/approve_bank_import_candidate", method: "POST", body: [
                "p_workspace_id": workspace.id.uuidString, "p_candidate_id": candidate.id.uuidString,
                "p_category_id": categoryId.uuidString, "p_remember_category": rememberCategory
            ])
            candidates.removeAll { $0.id == candidate.id }
            notice = "Approved and saved."
            if rememberCategory || createdPayee {
                payees = payees.map {
                    $0.id == resolvedPayee.id ? ReviewPayee(id: $0.id, name: $0.name, defaultCategoryId: categoryId) : $0
                }
            }
            if payeeId == nil && !createdPayee {
                do {
                    let rows: [ReviewPayee] = try await api.data("payees", query: scoped(workspace.id) + [
                        .init(name: "id", value: "eq.\(resolvedPayee.id)"),
                        .init(name: "select", value: "id,name,default_category_id")
                    ], method: "PATCH", body: [
                        "default_category_id": categoryId.uuidString, "default_account_id": candidate.accountId.uuidString
                    ])
                    if let updated = rows.first { payees = payees.map { $0.id == updated.id ? updated : $0 } }
                } catch {
                    errorMessage = "Transaction approved, but the payee defaults could not be saved: \(error.localizedDescription)"
                }
            }
            if rememberMapping, let importedName = candidate.payeeName, !importedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                do {
                    try await saveExactMapping(importedName, payee: resolvedPayee, replaceConflict: true)
                    try await rematchPendingCandidates(accountId: candidate.accountId)
                } catch {
                    errorMessage = "Transaction approved, but its bank description could not be saved as an alternative name: \(error.localizedDescription)"
                }
            }
            // The approval is committed even if refreshing the reports fails.
            do { budget = try await loadBudget(workspace.id); reports = try await loadReports(workspace.id) }
            catch { errorMessage = "Approval saved. Could not refresh Budget and Reports: \(error.localizedDescription)" }
        } catch { handle(error); throw error }
    }

    func createPayee(name: String, categoryId: UUID?, accountId: UUID) async throws -> ReviewPayee {
        guard !busy else { throw MobileAPIError(message: "Wait for the current request to finish.", status: 0) }
        busy = true; errorMessage = nil
        defer { busy = false }
        do { return try await insertPayee(name: name, categoryId: categoryId, accountId: accountId) }
        catch { handle(error); throw error }
    }

    func eligibleTransferAccounts(for candidate: ReviewTransaction) -> [ReviewAccount] {
        accounts.filter { $0.id != candidate.accountId && !$0.closed && $0.currency == candidate.currency }
    }

    func suggestedTransferAccount(for candidate: ReviewTransaction) -> ReviewAccount? {
        let matches = reviewTransfers.compactMap { transfer -> (ReviewTransfer, UUID, Int)? in
            guard transfer.currency == candidate.currency, let distance = Self.daysApart(transfer.transactionDate, candidate.transactionDate), distance <= 3 else { return nil }
            if candidate.transactionType == "expense", transfer.accountId == candidate.accountId, transfer.amountMinor == candidate.amountMinor,
               let destination = transfer.destinationAccountId { return (transfer, destination, distance) }
            if candidate.transactionType == "income", transfer.destinationAccountId == candidate.accountId,
               (transfer.destinationAmountMinor ?? transfer.amountMinor) == candidate.amountMinor { return (transfer, transfer.accountId, distance) }
            return nil
        }
        guard let closest = matches.map(\.2).min() else { return nil }
        let closestMatches = matches.filter { $0.2 == closest }
        guard closestMatches.count == 1 else { return nil }
        return accounts.first(where: { $0.id == closestMatches[0].1 })
    }

    func approveAsTransfer(_ candidate: ReviewTransaction, counterpartyAccountId: UUID) async throws {
        guard !busy, let workspace else { throw MobileAPIError(message: "Wait for the current request to finish.", status: 0) }
        guard accounts.contains(where: { $0.id == counterpartyAccountId && $0.id != candidate.accountId && $0.currency == candidate.currency }) else {
            throw MobileAPIError(message: "Choose another account in \(candidate.currency).", status: 0)
        }
        busy = true; errorMessage = nil
        defer { busy = false }
        do {
            let _: UUID = try await api.data("rpc/approve_bank_import_candidate_as_transfer", method: "POST", body: [
                "p_workspace_id": workspace.id.uuidString, "p_candidate_id": candidate.id.uuidString,
                "p_counterparty_account_id": counterpartyAccountId.uuidString
            ])
            candidates.removeAll { $0.id == candidate.id }
            notice = "Transfer matched and saved."
            do { budget = try await loadBudget(workspace.id); reports = try await loadReports(workspace.id) }
            catch { errorMessage = "Transfer saved. Could not refresh Budget and Reports: \(error.localizedDescription)" }
        } catch { handle(error); throw error }
    }

    func canSwipeApprove(_ candidate: ReviewTransaction) -> Bool {
        reviewReadiness(for: candidate) == .ready
    }

    func reviewReadiness(for candidate: ReviewTransaction) -> ReviewReadiness {
        let hasCategory = candidate.categoryId.map { id in categories.contains(where: { $0.id == id }) } ?? false
        let hasPayee: Bool
        if let payeeId = candidate.payeeId { hasPayee = payees.contains(where: { $0.id == payeeId }) }
        else { hasPayee = !(candidate.payeeName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
        switch (hasPayee, hasCategory) {
        case (true, true): return .ready
        case (false, true): return .missingPayee
        case (true, false): return .missingCategory
        case (false, false): return .missingPayeeAndCategory
        }
    }

    func possiblePayeeMatch(for candidate: ReviewTransaction) -> ReviewPayeeSuggestion? {
        guard candidate.payeeId == nil else { return nil }
        let sources = [(candidate.payeeName ?? "", false), (candidate.memo ?? "", true)].filter { !$0.0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let matches = payeeMappings.flatMap { mapping -> [ReviewPayeeSuggestion] in
            guard mapping.matchType == "exact", let payee = payees.first(where: { $0.id == mapping.payeeId }) else { return [] }
            let prefix = Self.normalizedPayeeName(mapping.sourceName)
            return sources.compactMap { source, isMemo in
                Self.prefixMappingMatches(Self.normalizedPayeeName(source), prefix)
                    ? ReviewPayeeSuggestion(mapping: mapping, payee: payee, sourceText: source, sourceIsMemo: isMemo)
                    : nil
            }
        }.sorted { Self.normalizedPayeeName($0.mapping.sourceName).count > Self.normalizedPayeeName($1.mapping.sourceName).count }
        guard let first = matches.first else { return nil }
        let longest = Self.normalizedPayeeName(first.mapping.sourceName).count
        let best = matches.filter { Self.normalizedPayeeName($0.mapping.sourceName).count == longest }
        return Set(best.map { $0.payee.id }).count == 1 ? first : nil
    }

    func promotePayeeMapping(_ suggestion: ReviewPayeeSuggestion) async throws {
        guard !busy, let workspace else { throw MobileAPIError(message: "Wait for the current request to finish.", status: 0) }
        busy = true; errorMessage = nil
        defer { busy = false }
        do {
            let rows: [ReviewPayeeMapping] = try await api.data("payee_mappings", query: scoped(workspace.id) + [
                .init(name: "id", value: "eq.\(suggestion.mapping.id)"), .init(name: "select", value: "id,source_name,payee_id,match_type")
            ], method: "PATCH", body: ["match_type": "starts_with"])
            guard let updated = rows.first else { throw MobileAPIError(message: "This payee match changed. Refresh and try again.", status: 409) }
            payeeMappings = payeeMappings.map { $0.id == updated.id ? updated : $0 }
        } catch { handle(error); throw error }
    }

    func addAlternativeName(_ sourceName: String, payee: ReviewPayee, accountId: UUID) async throws {
        guard !busy, workspace != nil else { throw MobileAPIError(message: "Wait for the current request to finish.", status: 0) }
        busy = true; errorMessage = nil
        defer { busy = false }
        do {
            try await saveExactMapping(sourceName, payee: payee, replaceConflict: false)
            try await rematchPendingCandidates(accountId: accountId)
        } catch { handle(error); throw error }
    }

    private func insertPayee(name: String, categoryId: UUID?, accountId: UUID) async throws -> ReviewPayee {
        guard let workspace else { throw MobileAPIError(message: "Choose a workspace first.", status: 0) }
        let cleaned = name.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { throw MobileAPIError(message: "A payee name is required.", status: 0) }
        if let existing = payees.first(where: { Self.normalizedPayeeName($0.name) == Self.normalizedPayeeName(cleaned) }) { return existing }
        let id = UUID()
        var body: [String: Any] = [
            "id": id.uuidString, "workspace_id": workspace.id.uuidString, "name": cleaned,
            "sort_order": payees.count, "default_account_id": accountId.uuidString
        ]
        if let categoryId { body["default_category_id"] = categoryId.uuidString }
        let rows: [ReviewPayee] = try await api.data("payees", query: [
            .init(name: "select", value: "id,name,default_category_id")
        ], method: "POST", body: body)
        guard let inserted = rows.first else { throw MobileAPIError(message: "The payee could not be created.", status: 0) }
        payees.append(inserted)
        payees.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return inserted
    }

    private func saveExactMapping(_ sourceName: String, payee: ReviewPayee, replaceConflict: Bool) async throws {
        guard let workspace else { throw MobileAPIError(message: "Choose a workspace first.", status: 0) }
        let cleaned = sourceName.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { throw MobileAPIError(message: "A bank description is required.", status: 0) }
        let normalized = Self.normalizedPayeeName(cleaned)
        if let existing = payeeMappings.first(where: { Self.normalizedPayeeName($0.sourceName) == normalized }) {
            if existing.payeeId == payee.id { return }
            guard replaceConflict else { throw MobileAPIError(message: "That alternative name already belongs to another payee.", status: 409) }
            let rows: [ReviewPayeeMapping] = try await api.data("payee_mappings", query: scoped(workspace.id) + [
                .init(name: "id", value: "eq.\(existing.id)"), .init(name: "select", value: "id,source_name,payee_id,match_type")
            ], method: "PATCH", body: [
                "source_name": cleaned, "normalized_name": normalized, "payee_id": payee.id.uuidString, "match_type": "exact"
            ])
            guard let updated = rows.first else { throw MobileAPIError(message: "The alternative name could not be updated.", status: 409) }
            payeeMappings = payeeMappings.map { $0.id == updated.id ? updated : $0 }
            return
        }
        let id = UUID()
        let rows: [ReviewPayeeMapping] = try await api.data("payee_mappings", query: [
            .init(name: "select", value: "id,source_name,payee_id,match_type")
        ], method: "POST", body: [
            "id": id.uuidString, "workspace_id": workspace.id.uuidString, "normalized_name": normalized,
            "source_name": cleaned, "payee_id": payee.id.uuidString, "match_type": "exact"
        ])
        guard let inserted = rows.first else { throw MobileAPIError(message: "The alternative name could not be saved.", status: 0) }
        payeeMappings.append(inserted)
    }

    private func rematchPendingCandidates(accountId: UUID) async throws {
        guard let workspace else { return }
        for candidate in candidates where candidate.accountId == accountId && candidate.payeeId == nil {
            let matched = [candidate.payeeName, candidate.memo].compactMap { $0 }.compactMap(matchedPayee).first
            guard let matched else { continue }
            var body: [String: Any] = ["payee_id": matched.id.uuidString]
            if let categoryId = matched.defaultCategoryId { body["category_id"] = categoryId.uuidString }
            let rows: [ReviewID] = try await api.data("bank_import_candidates", query: scoped(workspace.id) + [
                .init(name: "id", value: "eq.\(candidate.id)"), .init(name: "status", value: "eq.pending"),
                .init(name: "payee_id", value: "is.null"), .init(name: "select", value: "id")
            ], method: "PATCH", body: body)
            guard !rows.isEmpty else { continue }
            candidates = candidates.map { item in
                item.id == candidate.id ? ReviewTransaction(
                    id: item.id, accountId: item.accountId, transactionDate: item.transactionDate,
                    amountMinor: item.amountMinor, currency: item.currency, transactionType: item.transactionType,
                    payeeName: item.payeeName, payeeId: matched.id,
                    categoryId: matched.defaultCategoryId ?? item.categoryId, memo: item.memo
                ) : item
            }
        }
    }

    private func matchedPayee(_ sourceName: String) -> ReviewPayee? {
        let normalized = Self.normalizedPayeeName(sourceName)
        if let mapping = payeeMappings.first(where: { $0.matchType == "exact" && Self.normalizedPayeeName($0.sourceName) == normalized }),
           let payee = payees.first(where: { $0.id == mapping.payeeId }) { return payee }
        if let payee = payees.first(where: { Self.normalizedPayeeName($0.name) == normalized }) { return payee }
        let prefixMatches = payeeMappings.filter {
            $0.matchType == "starts_with" && Self.prefixMappingMatches(normalized, Self.normalizedPayeeName($0.sourceName))
        }.sorted { Self.normalizedPayeeName($0.sourceName).count > Self.normalizedPayeeName($1.sourceName).count }
        guard let first = prefixMatches.first else { return nil }
        let length = Self.normalizedPayeeName(first.sourceName).count
        let ids = Set(prefixMatches.filter { Self.normalizedPayeeName($0.sourceName).count == length }.map(\.payeeId))
        guard ids.count == 1, let id = ids.first else { return nil }
        return payees.first(where: { $0.id == id })
    }

    private static func normalizedPayeeName(_ value: String) -> String {
        value.precomposedStringWithCompatibilityMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased()
    }

    private static func prefixMappingMatches(_ source: String, _ prefix: String) -> Bool {
        guard source.hasPrefix(prefix), source.count > prefix.count else { return false }
        let boundary = source[source.index(source.startIndex, offsetBy: prefix.count)]
        return !boundary.isLetter && !boundary.isNumber
    }

    private static func daysApart(_ left: String, _ right: String) -> Int? {
        guard let leftDate = reviewDate(left), let rightDate = reviewDate(right) else { return nil }
        return abs(Calendar(identifier: .gregorian).dateComponents([.day], from: leftDate, to: rightDate).day ?? 0)
    }

    private static func shiftedReviewDate(_ value: String, days: Int) -> String? {
        guard let date = reviewDate(value), let shifted = Calendar(identifier: .gregorian).date(byAdding: .day, value: days, to: date) else { return nil }
        return reviewDateFormatter().string(from: shifted)
    }

    private static func reviewDate(_ value: String) -> Date? { reviewDateFormatter().date(from: value) }

    private static func reviewDateFormatter() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    func reject(_ candidate: ReviewTransaction) async throws {
        guard !busy, let workspace else { throw MobileAPIError(message: "Wait for the current request to finish.", status: 0) }
        busy = true
        defer { busy = false }
        do {
            let rows: [ReviewID] = try await api.data("bank_import_candidates", query: scoped(workspace.id) + [
                .init(name: "id", value: "eq.\(candidate.id)"), .init(name: "status", value: "eq.pending"), .init(name: "select", value: "id")
            ], method: "PATCH", body: ["status": "rejected", "decided_at": ISO8601DateFormatter().string(from: Date())])
            guard !rows.isEmpty else { throw MobileAPIError(message: "This transaction has already changed. Refresh the inbox.", status: 409) }
            candidates.removeAll { $0.id == candidate.id }
            notice = "Rejected. Future bank syncs will not offer this transaction again."
        } catch { handle(error); throw error }
    }

    private struct ReviewID: Decodable { let id: UUID }
    private func scoped(_ id: UUID) -> [URLQueryItem] { [.init(name: "workspace_id", value: "eq.\(id)")] }
    private func all<T: Decodable>(_ table: String, query: [URLQueryItem]) async throws -> [T] {
        var rows: [T] = []
        while true {
            let page: [T] = try await api.data(table, query: query + [.init(name: "limit", value: "500"), .init(name: "offset", value: String(rows.count))])
            rows += page
            if page.count < 500 { return rows }
        }
    }
    private func loadWorkspaces() async throws {
        // RLS supplies only memberships belonging to the authenticated user.
        let memberships: [WorkspaceMembership] = try await all("workspace_members", query: [.init(name: "select", value: "workspace_id"), .init(name: "order", value: "workspace_id")])
        guard !memberships.isEmpty else { workspaces = []; throw MobileAPIError(message: "Your account is not linked to a workspace yet. Use the same account as the web app.", status: 0) }
        let ids = memberships.map { $0.workspaceId.uuidString }.joined(separator: ",")
        workspaces = try await all("workspaces", query: [.init(name: "select", value: "id,name"), .init(name: "id", value: "in.(\(ids))"), .init(name: "order", value: "id")])
        if workspaces.count == 1, let first = workspaces.first {
            workspace = first
            try await loadSnapshot(first.id)
        }
    }
    private func loadSnapshot(_ id: UUID) async throws {
        let scope = scoped(id)
        let newCategories: [ReviewChoice] = try await all("categories", query: scope + [.init(name: "select", value: "id,name"), .init(name: "hidden", value: "eq.false"), .init(name: "order", value: "name,id")])
        let newPayees: [ReviewPayee] = try await all("payees", query: scope + [.init(name: "select", value: "id,name,default_category_id"), .init(name: "order", value: "name,id")])
        let newMappings: [ReviewPayeeMapping] = try await all("payee_mappings", query: scope + [.init(name: "select", value: "id,source_name,payee_id,match_type"), .init(name: "order", value: "id")])
        let newAccounts: [ReviewAccount] = try await all("accounts", query: scope + [.init(name: "select", value: "id,name,currency,closed"), .init(name: "order", value: "id")])
        let newCandidates: [ReviewTransaction] = try await all("bank_import_candidates", query: scope + [.init(name: "select", value: columns), .init(name: "status", value: "eq.pending"), .init(name: "order", value: "transaction_date.desc,id")])
        let newTransfers: [ReviewTransfer]
        if let firstDate = newCandidates.map(\.transactionDate).min(), let lastDate = newCandidates.map(\.transactionDate).max(),
           let start = Self.shiftedReviewDate(firstDate, days: -3), let end = Self.shiftedReviewDate(lastDate, days: 3) {
            newTransfers = try await all("transactions", query: scope + [
                .init(name: "select", value: "id,account_id,destination_account_id,transaction_date,amount_minor,destination_amount_minor,currency"),
                .init(name: "transaction_type", value: "eq.transfer"), .init(name: "transaction_date", value: "gte.\(start)"),
                .init(name: "transaction_date", value: "lte.\(end)"), .init(name: "order", value: "transaction_date.desc,id")
            ])
        } else { newTransfers = [] }
        categories = newCategories; payees = newPayees; payeeMappings = newMappings; accounts = newAccounts
        candidates = newCandidates; reviewTransfers = newTransfers
        budget = nil; budgetError = nil
        do { budget = try await loadBudget(id) } catch { budgetError = error.localizedDescription }
        reports = nil
        reports = try await loadReports(id)
    }
    private func loadBudget(_ id: UUID) async throws -> LiveBudget {
        let month = String(LiveReports.today().prefix(7))
        let nextMonth = LiveBudget.nextMonth(month)
        let configs: [ReportWorkspace] = try await api.data("workspaces", query: [.init(name: "id", value: "eq.\(id)"), .init(name: "select", value: "default_currency,yearly_spending_goals")])
        guard let config = configs.first else { throw MobileAPIError(message: "Budget settings could not be loaded.", status: 0) }
        let groups: [MobileBudgetGroup] = try await all("category_groups", query: scoped(id) + [.init(name: "select", value: "id,name,sort_order"), .init(name: "order", value: "sort_order,name,id")])
        let categories: [MobileBudgetCategory] = try await all("categories", query: scoped(id) + [.init(name: "select", value: "id,name,category_group_id,sort_order,default_budget_minor,color,icon,report_group,hidden"), .init(name: "order", value: "sort_order,name,id")])
        let periods: [ReviewID] = try await api.data("periods", query: scoped(id) + [.init(name: "select", value: "id"), .init(name: "year", value: "eq.\(month.prefix(4))"), .init(name: "month", value: "eq.\(Int(month.suffix(2))!)")])
        var overrides: [MobileBudgetOverride] = []
        if !periods.isEmpty {
            overrides = try await all("budgets", query: scoped(id) + [.init(name: "select", value: "category_id,amount_minor"), .init(name: "period_id", value: "in.(\(periods.map { $0.id.uuidString }.joined(separator: ",")))"), .init(name: "order", value: "id")])
        }
        let rates: [ReportRate] = try await all("fx_rates", query: scoped(id) + [.init(name: "select", value: "base_currency,quote_currency,rate_hundredths,rate_date"), .init(name: "order", value: "rate_date,id")])
        let activity: [ReviewTransaction] = try await all("transactions", query: scoped(id) + [.init(name: "select", value: columns), .init(name: "transaction_date", value: "gte.\(month)-01"), .init(name: "and", value: "(transaction_date.lt.\(nextMonth)-01)"), .init(name: "transaction_type", value: "in.(income,expense)"), .init(name: "order", value: "transaction_date.desc,id")])
        return try LiveBudget.calculate(month: month, currency: config.defaultCurrency, groups: groups, categories: categories, overrides: overrides, activity: activity, rates: rates)
    }

    private func loadReports(_ id: UUID) async throws -> LiveReports {
        let today = LiveReports.today()
        let year = String(today.prefix(4))
        let configs: [ReportWorkspace] = try await api.data("workspaces", query: [
            .init(name: "id", value: "eq.\(id)"), .init(name: "select", value: "default_currency,yearly_spending_goals")
        ])
        guard let config = configs.first else { throw MobileAPIError(message: "Report settings could not be loaded.", status: 0) }
        let balances: [ReportBalance] = try await api.data("rpc/workspace_account_balances", method: "POST", body: ["p_workspace_id": id.uuidString])
        let reportAccounts: [ReportAccount] = try await all("accounts", query: scoped(id) + [.init(name: "select", value: "id,name,currency,closed,scope,balance_sheet_group,pension"), .init(name: "order", value: "id")])
        let reportCategories: [ReportCategory] = try await all("categories", query: scoped(id) + [.init(name: "select", value: "id,report_group"), .init(name: "order", value: "id")])
        let rates: [ReportRate] = try await all("fx_rates", query: scoped(id) + [.init(name: "select", value: "base_currency,quote_currency,rate_hundredths,rate_date"), .init(name: "order", value: "rate_date,id")])
        let activity: [ReportActivity] = try await all("transactions", query: scoped(id) + [
            .init(name: "select", value: "transaction_date,amount_minor,currency,transaction_type,category_id"),
            .init(name: "transaction_date", value: "gte.\(year)-01-01"),
            .init(name: "and", value: "(transaction_date.lte.\(today))"),
            .init(name: "transaction_type", value: "in.(income,expense)"), .init(name: "order", value: "id")
        ])
        return try LiveReports.calculate(config: config, accounts: reportAccounts, balances: balances, categories: reportCategories, activity: activity, rates: rates, today: today)
    }
    private func handle(_ error: Error) {
        if let failure = error as? MobileAPIError, failure.status == 401 {
            try? api.clearSession()
            reset()
        }
        errorMessage = error.localizedDescription
    }
    private func clearWorkspace() {
        workspace = nil; candidates = []; reports = nil; budget = nil; budgetError = nil; categories = []; payees = []; payeeMappings = []; accounts = []; reviewTransfers = []; notice = nil; bankSyncResults = []
    }
    private func reset() { signedIn = false; workspaces = []; clearWorkspace() }
}

struct ReportWorkspace: Decodable {
    let defaultCurrency: String
    let yearlySpendingGoals: [String: ReportPlan]?
}
struct ReportPlan: Decodable {
    var personalSpendingMinor: Int?
    var companySpendingMinor: Int?
    var projectedCompanyIncomeMinor: Int?
    var projectedIncomeMinor: Int?
    var savingsGoalMinor: Int?
    var projectedTaxesMinor: Int?
    var monthlySalaryMinor: Int?
    var monthlySalaryTaxMinor: Int?
    var monthlySocialSecurityMinor: Int?
    var estimatedDividendMinor: Int?
    var corporateTaxRateBps: Int?
    var dividendTaxRateBps: Int?
    var combinedGoal: Int? {
        guard let company = companySpendingMinor, company >= 0 else { return nil }
        if let personal = personalSpendingMinor, personal >= 0 { return personal + company }
        guard let income = projectedCompanyIncomeMinor ?? projectedIncomeMinor, let savings = savingsGoalMinor else { return nil }
        let taxes: Int
        if let salary = monthlySalaryMinor, let salaryTax = monthlySalaryTaxMinor, let social = monthlySocialSecurityMinor,
           let dividend = estimatedDividendMinor, let corporateRate = corporateTaxRateBps, let dividendRate = dividendTaxRateBps {
            let taxable = max(0, income - company - (salary + salaryTax + social) * 12)
            taxes = (salaryTax + social) * 12 + Int((Double(taxable) * Double(corporateRate) / 10000).rounded()) + Int((Double(dividend) * Double(dividendRate) / 10000).rounded())
        } else if let legacy = projectedTaxesMinor { taxes = legacy }
        else { return nil }
        return max(0, income - taxes - savings - company) + company
    }
}
struct ReportAccount: Decodable {
    let id: UUID; let name: String; let currency: String; let closed: Bool
    let scope: String; let balanceSheetGroup: String?; let pension: Bool?
    var group: String {
        balanceSheetGroup ?? ((pension ?? false) ? "Pension" : (name.range(of: "apartment|mortgage|bolån", options: [.regularExpression, .caseInsensitive]) != nil ? "Real estate" : scope))
    }
}
struct ReportBalance: Decodable { let accountId: UUID; let balanceMinor: Int }
struct ReportCategory: Decodable { let id: UUID; let reportGroup: String? }
struct ReportRate: Decodable { let baseCurrency: String; let quoteCurrency: String; let rateHundredths: Double; let rateDate: String }
struct ReportActivity: Decodable { let transactionDate: String; let amountMinor: Int; let currency: String; let transactionType: String; let categoryId: UUID? }
struct LiveReports {
    let currency: String; let throughDate: String; let netWorth: Int; let assets: Int; let liabilities: Int
    let groups: [String: Int]; let expenses: Int; let personalExpenses: Int; let companyExpenses: Int; let goal: Int?
    static func today() -> String {
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(identifier: "Europe/Paris"); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }
    static func converted(_ amount: Int, _ currency: String, _ date: String, target: String, rates: [ReportRate]) throws -> Int {
            if currency == target { return amount }
            guard let rate = rates.filter({ $0.rateDate.prefix(7) <= date.prefix(7) && (($0.baseCurrency == currency && $0.quoteCurrency == target) || ($0.quoteCurrency == currency && $0.baseCurrency == target)) }).sorted(by: { $0.rateDate > $1.rateDate }).first, rate.rateHundredths > 0 else {
                throw MobileAPIError(message: "Add a saved \(currency)/\(target) exchange rate in the web app to show complete reports.", status: 0)
            }
            let value = rate.baseCurrency == currency ? Double(amount) * rate.rateHundredths / 100 : Double(amount) * 100 / rate.rateHundredths
            return Int(floor(value + 0.5))
        }

    static func calculate(config: ReportWorkspace, accounts: [ReportAccount], balances: [ReportBalance], categories: [ReportCategory], activity: [ReportActivity], rates: [ReportRate], today: String) throws -> LiveReports {
        var groups: [String: Int] = [:]; var assets = 0; var liabilities = 0
        for account in accounts where !account.closed {
            guard let balance = balances.first(where: { $0.accountId == account.id }) else { throw MobileAPIError(message: "Account balances are incomplete. Pull to refresh.", status: 0) }
            let value = try converted(balance.balanceMinor, account.currency, today, target: config.defaultCurrency, rates: rates)
            groups[account.group, default: 0] += value
            if value >= 0 { assets += value } else { liabilities -= value }
        }
        var personal = 0; var company = 0
        for item in activity where item.transactionDate >= "\(today.prefix(4))-01-01" && item.transactionDate <= today && ["income", "expense"].contains(item.transactionType) {
            guard let group = categories.first(where: { $0.id == item.categoryId })?.reportGroup,
                  ["personal_expense", "company_expense"].contains(group) else { continue }
            let amount = try converted(item.amountMinor, item.currency, item.transactionDate, target: config.defaultCurrency, rates: rates) * (item.transactionType == "income" ? -1 : 1)
            if group == "personal_expense" { personal += amount } else { company += amount }
        }
        return LiveReports(currency: config.defaultCurrency, throughDate: today, netWorth: assets - liabilities, assets: assets, liabilities: liabilities, groups: groups, expenses: personal + company, personalExpenses: personal, companyExpenses: company, goal: config.yearlySpendingGoals?[String(today.prefix(4))]?.combinedGoal)
    }
}

struct SpendingPace {
    let elapsedDays: Int
    let daysInYear: Int
    let target: Int
    let variance: Int
    var yearFraction: Double { Double(elapsedDays) / Double(daysInYear) }

    init?(throughDate: String, annualGoal: Int, expenses: Int) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let formatter = DateFormatter()
        formatter.calendar = calendar; formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        guard annualGoal >= 0, let date = formatter.date(from: throughDate),
              let elapsed = calendar.ordinality(of: .day, in: .year, for: date),
              let days = calendar.range(of: .day, in: .year, for: date)?.count else { return nil }
        elapsedDays = elapsed; daysInYear = days
        // Include today; calendar days keep leap years and DST unambiguous.
        target = Int((Double(annualGoal) * Double(elapsed) / Double(days)).rounded())
        variance = expenses - target
    }
}

struct MobileBudgetGroup: Decodable, Identifiable {
    let id: UUID; let name: String; let sortOrder: Int?
}
struct MobileBudgetCategory: Decodable, Identifiable {
    let id: UUID; let name: String; let categoryGroupId: UUID?
    let sortOrder: Int?; let defaultBudgetMinor: Int?
    let color: String?; let icon: String?; let reportGroup: String?; let hidden: Bool?
    var isIncome: Bool { ["personal_income", "company_revenue"].contains(reportGroup ?? "") }
    var symbol: String {
        let symbols = ["banknote": "banknote.fill", "basket": "cart.fill", "briefcase": "briefcase.fill", "car": "car.fill", "credit-card": "creditcard.fill", "dumbbell": "dumbbell.fill", "heart": "heart.fill", "house": "house.fill", "medical": "cross.case.fill", "plane": "airplane", "receipt": "receipt", "shield": "exclamationmark.shield.fill", "shopping-bag": "bag.fill", "sparkles": "sparkles", "target": "target", "tv": "play.tv.fill", "utensils": "fork.knife", "wine": "wineglass.fill", "zap": "bolt.fill"]
        let key = (icon ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let symbol = symbols[key] { return symbol }
        if symbols.values.contains(key) { return key }
        let rules: [(String, String)] = [("salary|business", "briefcase"), ("income|saving|dividend|investment|emergency fund", "banknote"), ("grocer", "basket"), ("going out|per diem", "utensils"), ("leisure", "tv"), ("transport|car", "car"), ("apartment|rent", "house"), ("insurance", "shield"), ("shopping", "shopping-bag"), ("utilit", "zap"), ("cleaning", "target"), ("gym", "dumbbell"), ("medical", "medical"), ("subscription", "credit-card"), ("travel", "plane"), ("tax|fee|expense", "receipt"), ("charity", "heart")]
        return rules.first { name.lowercased().range(of: $0.0, options: .regularExpression) != nil }.flatMap { symbols[$0.1] } ?? "sparkles"
    }
}
struct MobileBudgetOverride: Decodable { let categoryId: UUID; let amountMinor: Int }
struct LiveBudget {
    struct Category: Identifiable {
        let category: MobileBudgetCategory; let spent: Int; let budget: Int; let transactions: [ReviewTransaction]
        var id: UUID { category.id }
        var fraction: Double { budget > 0 ? Double(spent) / Double(budget) : 0 }
    }
    struct Group: Identifiable { let id: String; let name: String; let categories: [Category] }
    let month: String; let currency: String; let groups: [Group]
    var monthTitle: String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: month + "-01") else { return month }
        formatter.locale = .current; formatter.dateFormat = "LLLL yyyy"
        return formatter.string(from: date)
    }
    static func nextMonth(_ month: String) -> String {
        let year = Int(month.prefix(4))!; let number = Int(month.suffix(2))!
        return number == 12 ? "\(year + 1)-01" : String(format: "%04d-%02d", year, number + 1)
    }
    static func calculate(month: String, currency: String, groups: [MobileBudgetGroup], categories: [MobileBudgetCategory], overrides: [MobileBudgetOverride], activity: [ReviewTransaction], rates: [ReportRate]) throws -> LiveBudget {
        let rows = try categories.sorted { ($0.sortOrder ?? 0, $0.name, $0.id.uuidString) < ($1.sortOrder ?? 0, $1.name, $1.id.uuidString) }.map { category in
            let transactions = activity.filter { $0.categoryId == category.id && $0.transactionDate.hasPrefix(month + "-") && ["income", "expense"].contains($0.transactionType) }.sorted { ($0.transactionDate, $0.id.uuidString) > ($1.transactionDate, $1.id.uuidString) }
            let spent = try transactions.reduce(0) { sum, transaction in
                let amount = try LiveReports.converted(transaction.amountMinor, transaction.currency, transaction.transactionDate, target: currency, rates: rates)
                let income = transaction.transactionType == "income"
                return sum + amount * (category.isIncome == income ? 1 : -1)
            }
            return Category(category: category, spent: spent, budget: overrides.first { $0.categoryId == category.id }?.amountMinor ?? category.defaultBudgetMinor ?? 0, transactions: transactions)
        }
        var sections = groups.sorted { ($0.sortOrder ?? 0, $0.name) < ($1.sortOrder ?? 0, $1.name) }.map { group in
            Group(id: group.id.uuidString, name: group.name, categories: rows.filter { $0.category.categoryGroupId == group.id })
        }.filter { !$0.categories.isEmpty }
        let known = Set(groups.map { $0.id })
        let other = rows.filter { $0.category.categoryGroupId.map { !known.contains($0) } ?? true }
        if !other.isEmpty { sections.append(Group(id: "other", name: "Other", categories: other)) }
        return LiveBudget(month: month, currency: currency, groups: sections)
    }
}
