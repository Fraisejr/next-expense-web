import Combine
import Foundation

struct WorkspaceMembership: Decodable { let workspaceId: UUID }
struct ReviewWorkspace: Decodable, Identifiable { let id: UUID; let name: String }
struct ReviewChoice: Decodable, Identifiable, Hashable { let id: UUID; let name: String }
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

@MainActor
final class LiveExpenseStore: ObservableObject {
    @Published private(set) var signedIn = false
    @Published private(set) var busy = false
    @Published private(set) var workspaces: [ReviewWorkspace] = []
    @Published private(set) var workspace: ReviewWorkspace?
    @Published private(set) var candidates: [ReviewTransaction] = []
    @Published private(set) var ledger: [ReviewTransaction] = []
    @Published private(set) var categories: [ReviewChoice] = []
    @Published private(set) var payees: [ReviewChoice] = []
    @Published private(set) var accounts: [ReviewChoice] = []
    @Published var errorMessage: String?
    @Published var notice: String?
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

    func approve(_ candidate: ReviewTransaction, payeeId: UUID?, categoryId: UUID?) async throws {
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
            // Same two-step flow as the web app. Only change the payee if edited,
            // so retrying an approval whose response was lost reaches the idempotent RPC.
            if payeeId != candidate.payeeId {
                let rows: [ReviewID] = try await api.data("bank_import_candidates", query: scoped(workspace.id) + [
                    .init(name: "id", value: "eq.\(candidate.id)"), .init(name: "status", value: "eq.pending"), .init(name: "select", value: "id")
                ], method: "PATCH", body: ["payee_id": payeeId.map { $0.uuidString as Any } ?? NSNull()])
                if rows.isEmpty {
                    // An earlier attempt may already have committed. The RPC verifies status.
                    notice = "Checking whether this transaction was already approved."
                }
            }
            let transactionId: UUID = try await api.data("rpc/approve_bank_import_candidate", method: "POST", body: [
                "p_workspace_id": workspace.id.uuidString, "p_candidate_id": candidate.id.uuidString,
                "p_category_id": categoryId.uuidString, "p_remember_category": false
            ])
            candidates.removeAll { $0.id == candidate.id }
            notice = "Approved and saved to the shared ledger. Refresh the web app to see it."
            // A refresh failure must not turn a committed approval into an apparent failure.
            do {
                let saved: [ReviewTransaction] = try await api.data("transactions", query: scoped(workspace.id) + [
                    .init(name: "select", value: columns), .init(name: "id", value: "eq.\(transactionId)")
                ])
                ledger.removeAll { $0.id == transactionId }
                ledger.insert(contentsOf: saved, at: 0)
            } catch { errorMessage = "Approval saved. Could not reload the ledger: \(error.localizedDescription)" }
        } catch { handle(error); throw error }
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
        let newPayees: [ReviewChoice] = try await all("payees", query: scope + [.init(name: "select", value: "id,name"), .init(name: "order", value: "name,id")])
        let newAccounts: [ReviewChoice] = try await all("accounts", query: scope + [.init(name: "select", value: "id,name"), .init(name: "order", value: "id")])
        let newCandidates: [ReviewTransaction] = try await all("bank_import_candidates", query: scope + [.init(name: "select", value: columns), .init(name: "status", value: "eq.pending"), .init(name: "order", value: "transaction_date.desc,id")])
        let newLedger: [ReviewTransaction] = try await api.data("transactions", query: scope + [.init(name: "select", value: columns), .init(name: "order", value: "transaction_date.desc,id"), .init(name: "limit", value: "50")])
        categories = newCategories; payees = newPayees; accounts = newAccounts
        candidates = newCandidates; ledger = newLedger
    }
    private func handle(_ error: Error) {
        if let failure = error as? MobileAPIError, failure.status == 401 {
            try? api.clearSession()
            reset()
        }
        errorMessage = error.localizedDescription
    }
    private func clearWorkspace() {
        workspace = nil; candidates = []; ledger = []; categories = []; payees = []; accounts = []; notice = nil
    }
    private func reset() { signedIn = false; workspaces = []; clearWorkspace() }
}
