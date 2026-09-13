import AuthenticationServices
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
    @Published private(set) var reports: LiveReports?
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
            let _: UUID = try await api.data("rpc/approve_bank_import_candidate", method: "POST", body: [
                "p_workspace_id": workspace.id.uuidString, "p_candidate_id": candidate.id.uuidString,
                "p_category_id": categoryId.uuidString, "p_remember_category": false
            ])
            candidates.removeAll { $0.id == candidate.id }
            notice = "Approved and saved."
            // The approval is committed even if refreshing the reports fails.
            do { reports = try await loadReports(workspace.id) }
            catch { errorMessage = "Approval saved. Could not refresh reports: \(error.localizedDescription)" }
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
        categories = newCategories; payees = newPayees; accounts = newAccounts
        candidates = newCandidates
        reports = nil
        reports = try await loadReports(id)
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
        workspace = nil; candidates = []; reports = nil; categories = []; payees = []; accounts = []; notice = nil
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
    static func calculate(config: ReportWorkspace, accounts: [ReportAccount], balances: [ReportBalance], categories: [ReportCategory], activity: [ReportActivity], rates: [ReportRate], today: String) throws -> LiveReports {
        func converted(_ amount: Int, _ currency: String, _ date: String) throws -> Int {
            if currency == config.defaultCurrency { return amount }
            guard let rate = rates.filter({ $0.rateDate.prefix(7) <= date.prefix(7) && (($0.baseCurrency == currency && $0.quoteCurrency == config.defaultCurrency) || ($0.quoteCurrency == currency && $0.baseCurrency == config.defaultCurrency)) }).sorted(by: { $0.rateDate > $1.rateDate }).first, rate.rateHundredths > 0 else {
                throw MobileAPIError(message: "Add a saved \(currency)/\(config.defaultCurrency) exchange rate in the web app to show complete reports.", status: 0)
            }
            let value = rate.baseCurrency == currency ? Double(amount) * rate.rateHundredths / 100 : Double(amount) * 100 / rate.rateHundredths
            return Int(floor(value + 0.5))
        }
        var groups: [String: Int] = [:]; var assets = 0; var liabilities = 0
        for account in accounts where !account.closed {
            guard let balance = balances.first(where: { $0.accountId == account.id }) else { throw MobileAPIError(message: "Account balances are incomplete. Pull to refresh.", status: 0) }
            let value = try converted(balance.balanceMinor, account.currency, today)
            groups[account.group, default: 0] += value
            if value >= 0 { assets += value } else { liabilities -= value }
        }
        var personal = 0; var company = 0
        for item in activity where item.transactionDate >= "\(today.prefix(4))-01-01" && item.transactionDate <= today && ["income", "expense"].contains(item.transactionType) {
            guard let group = categories.first(where: { $0.id == item.categoryId })?.reportGroup,
                  ["personal_expense", "company_expense"].contains(group) else { continue }
            let amount = try converted(item.amountMinor, item.currency, item.transactionDate) * (item.transactionType == "income" ? -1 : 1)
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
