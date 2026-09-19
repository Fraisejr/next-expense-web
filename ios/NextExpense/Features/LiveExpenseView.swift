import SwiftUI

struct LiveExpenseView: View {
    @StateObject private var store = LiveExpenseStore()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("showBankSyncResults") private var showBankSyncResults = true
    @State private var email = ""
    @State private var password = ""
    @State private var selected: ReviewTransaction?
    @State private var confirmingApproveAll = false
    @State private var showingClosedAccounts = false

    var body: some View {
        Group {
            if !store.signedIn { signIn }
            else if store.workspace == nil { workspacePicker }
            else {
                TabView {
                    budgetTab
                    accountsTab
                    reportsTab
                    NavigationStack {
                        List {
                            messages
                            if store.readyCandidateCount > 0 {
                                Button { confirmingApproveAll = true } label: {
                                    Label("Approve all ready (\(store.readyCandidateCount))", systemImage: "checkmark.circle.fill")
                                }
                                .tint(.teal)
                                .disabled(store.busy)
                            }
                            if store.candidates.contains(where: { $0.payeeId == nil }) {
                                Button { Task { await store.recheckPayees() } } label: {
                                    Label("Recheck payees", systemImage: "arrow.triangle.2.circlepath")
                                }
                                .disabled(store.busy)
                            }
                            if store.candidates.isEmpty && !store.busy && store.errorMessage == nil {
                                ContentUnavailableView("You’re all caught up", systemImage: "checkmark.circle", description: Text("Tap Sync banks to check for new imports."))
                            }
                            ForEach(store.candidates) { candidate in
                                row(candidate)
                                    .contentShape(Rectangle())
                                    .onTapGesture { if !store.busy { selected = candidate } }
                                    .accessibilityAddTraits(.isButton)
                                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                        if !store.busy && store.canSwipeApprove(candidate) {
                                            Button {
                                                Task { try? await store.approve(candidate, payeeId: candidate.payeeId, categoryId: candidate.categoryId) }
                                            } label: { Label("Approve", systemImage: "checkmark") }
                                                .tint(.teal)
                                        }
                                    }
                            }
                        }
                        .navigationTitle("Review")
                        .refreshable { await store.refresh() }
                        .toolbar { toolbar }
                        .confirmationDialog(
                            "Approve \(store.readyCandidateCount) ready transactions?",
                            isPresented: $confirmingApproveAll,
                            titleVisibility: .visible
                        ) {
                            Button("Approve \(store.readyCandidateCount)") {
                                Task { await store.approveAllReady() }
                            }
                            Button("Cancel", role: .cancel) {}
                        } message: {
                            Text("Only transactions with a usable payee and active category will be approved. The others will remain in Review.")
                        }
                    }
                    .tabItem { Label("Review", systemImage: "tray.full.fill") }
                    .badge(store.candidates.count)

                }
            }
        }
        .tint(.teal)
        .task { await store.restore() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && store.signedIn { Task { await store.refresh() } }
        }
        .sheet(item: $selected) { candidate in LiveCandidateView(store: store, candidate: candidate) }
    }

    private var budgetTab: some View {
        NavigationStack {
            List {
                messages
                if let budget = store.budget {
                    ForEach(budget.groups) { group in
                        let rows = group.categories.filter { $0.category.hidden != true }
                        if !rows.isEmpty {
                            Section(group.name) {
                                ForEach(rows) { item in
                                    NavigationLink {
                                        LiveBudgetCategoryView(store: store, categoryId: item.id)
                                    } label: {
                                        LiveBudgetRow(item: item, currency: budget.currency)
                                    }
                                }
                            }
                        }
                    }
                    if !budget.groups.flatMap({ $0.categories }).contains(where: { $0.category.hidden != true }) {
                        ContentUnavailableView("No categories yet", systemImage: "square.grid.2x2", description: Text("Set up categories and budgets in the web app."))
                    }
                } else if let error = store.budgetError {
                    Text(error).foregroundStyle(.red)
                } else if !store.busy {
                    ContentUnavailableView("Budget unavailable", systemImage: "chart.bar", description: Text("Pull to refresh your workspace."))
                }
            }
            .navigationTitle("Budget")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await store.refresh() }
            .toolbar {
                toolbar
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text("Budget").font(.headline)
                        if let budget = store.budget {
                            Text(budget.monthTitle).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .tabItem { Label("Budget", systemImage: "chart.pie.fill") }
    }

    private var accountsTab: some View {
        NavigationStack {
            List {
                messages
                ForEach(["Personal", "Company", "Real estate", "Pension"], id: \.self) { group in
                    let rows = store.accounts.filter { !$0.closed && $0.group == group }
                    if !rows.isEmpty { accountSection(group, accounts: rows) }
                }
                let closed = store.accounts.filter(\.closed)
                if !closed.isEmpty {
                    Section {
                        DisclosureGroup(isExpanded: $showingClosedAccounts) {
                            ForEach(closed) { account in accountRow(account) }
                        } label: {
                            HStack {
                                Text("Closed accounts")
                                Spacer()
                                Text(accountGroupSummary(closed)).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if store.accounts.isEmpty && !store.busy && store.errorMessage == nil {
                    ContentUnavailableView("No accounts yet", systemImage: "wallet.pass", description: Text("Create an account in the web app."))
                }
            }
            .navigationTitle("Accounts")
            .refreshable { await store.refresh() }
            .toolbar { toolbar }
        }
        .tabItem { Label("Accounts", systemImage: "wallet.pass.fill") }
    }

    private func accountSection(_ title: String, accounts: [ReviewAccount]) -> some View {
        Section {
            ForEach(accounts) { account in accountRow(account) }
        } header: {
            HStack {
                Text(title)
                Spacer()
                Text(accountGroupSummary(accounts)).textCase(nil)
            }
        }
    }

    private func accountRow(_ account: ReviewAccount) -> some View {
        HStack(spacing: 12) {
            Circle().fill(accountColor(account.color)).frame(width: 10, height: 10)
                .accessibilityHidden(true)
            Text(account.name).foregroundStyle(.primary)
            Spacer()
            if let balance = store.accountBalances[account.id] {
                Text(formattedMoney(balance, currency: account.currency))
                    .monospacedDigit().fontWeight(.semibold)
                    .foregroundStyle(balance < 0 ? Color.red : Color.primary)
            } else { Text("—").foregroundStyle(.secondary) }
        }
        .padding(.vertical, 2)
    }

    private func accountGroupSummary(_ accounts: [ReviewAccount]) -> String {
        let currencies = Set(accounts.map(\.currency))
        if currencies.count == 1, let currency = currencies.first,
           accounts.allSatisfy({ store.accountBalances[$0.id] != nil }) {
            return formattedMoney(accounts.reduce(0) { $0 + (store.accountBalances[$1.id] ?? 0) }, currency: currency)
        }
        return "\(accounts.count) \(accounts.count == 1 ? "account" : "accounts")"
    }

    private func accountColor(_ value: String?) -> Color {
        let raw = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: "")
        let hex = raw.count == 6 ? UInt32(raw, radix: 16) ?? 0x5D7D91 : 0x5D7D91
        return Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }

    private var reportsTab: some View {
        NavigationStack {
            List {
                messages
                if let report = store.reports {
                    Section {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Expenses so far this year").font(.headline)
                            if let goal = report.goal, let pace = SpendingPace(throughDate: report.throughDate, annualGoal: goal, expenses: report.expenses) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(pace.variance > 0 ? "Above year-to-date target" : pace.variance < 0 ? "Below year-to-date target" : "On year-to-date target")
                                        .font(.headline)
                                    Text(formattedMoney(abs(pace.variance), currency: report.currency))
                                        .font(.system(.largeTitle, design: .rounded).bold()).minimumScaleFactor(0.6)
                                }
                                .foregroundStyle(pace.variance > 0 ? Color.orange : Color.teal)
                                Text("\(pace.elapsedDays) of \(pace.daysInYear) days · \(pace.yearFraction * 100, specifier: "%.1f")% of the year")
                                    .font(.subheadline).foregroundStyle(.secondary)
                                VStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 5) {
                                        LabeledContent("Actual spending", value: formattedMoney(report.expenses, currency: report.currency))
                                        ProgressView(value: Double(max(report.expenses, 0)), total: Double(max(goal, report.expenses, 1)))
                                            .tint(pace.variance > 0 ? .orange : .teal)
                                    }
                                    VStack(alignment: .leading, spacing: 5) {
                                        LabeledContent("Year-to-date target", value: formattedMoney(pace.target, currency: report.currency))
                                        ProgressView(value: Double(pace.target), total: Double(max(goal, report.expenses, 1))).tint(.secondary)
                                    }
                                }
                                LabeledContent("Combined spending goal", value: formattedMoney(goal, currency: report.currency))
                                Text("Target = annual goal × days elapsed ÷ days in the year, including today.")
                                    .font(.caption).foregroundStyle(.secondary)
                            } else {
                                Text(formattedMoney(report.expenses, currency: report.currency)).font(.title.bold())
                                Text("Set your annual spending goal in the web app.").foregroundStyle(.secondary)
                            }
                        }.padding(.vertical, 8)
                        LabeledContent("Personal expenses", value: formattedMoney(report.personalExpenses, currency: report.currency))
                        LabeledContent("Company expenses", value: formattedMoney(report.companyExpenses, currency: report.currency))
                    } header: { Text("Year to date · \(String(report.throughDate.prefix(4)))") }
                    footer: { Text("Through \(report.throughDate). Personal + company expenses, net of refunds. Taxes, transfers and unapproved imports are excluded. Uses saved exchange rates, as on the web.") }
                    Section {
                        VStack(alignment: .leading, spacing: 12) {
                            Label("Current net worth", systemImage: "chart.pie.fill").foregroundStyle(.secondary)
                            Text(formattedMoney(report.netWorth, currency: report.currency))
                                .font(.system(.largeTitle, design: .rounded).bold()).minimumScaleFactor(0.6)
                            HStack {
                                VStack(alignment: .leading) { Text("Assets").font(.caption); Text(formattedMoney(report.assets, currency: report.currency)).fontWeight(.semibold) }
                                Spacer()
                                VStack(alignment: .trailing) { Text("Liabilities").font(.caption); Text(formattedMoney(report.liabilities, currency: report.currency)).fontWeight(.semibold) }
                            }.foregroundStyle(.secondary)
                        }.padding(.vertical, 8)
                        ForEach(["Personal", "Company", "Real estate", "Pension"], id: \.self) { group in
                            if let amount = report.groups[group] { LabeledContent(group, value: formattedMoney(amount, currency: report.currency)) }
                        }
                    } footer: { Text("Balances across open accounts, including property and pensions, less liabilities.") }
                } else if !store.busy && store.errorMessage == nil {
                    ContentUnavailableView("Reports unavailable", systemImage: "chart.bar", description: Text("Pull to refresh your workspace."))
                }
            }
            .navigationTitle("Reports")
            .refreshable { await store.refresh() }
            .toolbar { toolbar }
        }
        .tabItem { Label("Reports", systemImage: "chart.bar.fill") }
    }

    private var signIn: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Next Expense", systemImage: "chart.bar.fill").font(.title2.bold())
                    Text("Sign in with the same account you use on the web to see your reports and review bank imports.")
                        .foregroundStyle(.secondary)
                }
                Section {
                    Button {
                        Task { await store.signInWithGoogle() }
                    } label: {
                        Text("Continue with Google")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity, minHeight: 32)
                    }
                    .disabled(store.busy)
                }
                Section("Or use email and password") {
                    TextField("Email", text: $email).textContentType(.username).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password", text: $password).textContentType(.password)
                    Button("Sign in") {
                        let enteredPassword = password
                        password = ""
                        Task { await store.signIn(email: email, password: enteredPassword) }
                    }
                    .disabled(store.busy || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
                }
                if store.busy { ProgressView("Connecting…") }
                if let error = store.errorMessage { Text(error).foregroundStyle(.red) }
                Section {
                    Text("Use the same Google account as the website. You don’t need to create a password.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Welcome")
        }
    }

    private var workspacePicker: some View {
        NavigationStack {
            List {
                messages
                ForEach(store.workspaces) { workspace in
                    Button(workspace.name) { Task { await store.select(workspace) } }.disabled(store.busy)
                }
                Button("Sign out") { Task { await store.signOut() } }.disabled(store.busy)
            }
            .navigationTitle("Choose workspace")
            .refreshable { await store.refresh() }
        }
    }

    @ViewBuilder private var messages: some View {
        if store.busy { ProgressView(store.syncingBanks ? "Syncing banks…" : "Updating…") }
        if showBankSyncResults && !store.bankSyncResults.isEmpty {
            Section {
                ForEach(store.bankSyncResults) { result in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(result.name).font(.headline)
                        Text(result.message).font(.footnote).foregroundStyle(result.failed ? Color.orange : Color.secondary)
                    }
                }
            } header: {
                HStack { Text("Bank sync"); Spacer(); Button("Hide") { showBankSyncResults = false }.textCase(nil) }
            }
        }
        if let error = store.errorMessage {
            Section { Text(error).foregroundStyle(.red); Button("Retry") { Task { await store.refresh() } }.disabled(store.busy) }
        }
        if let notice = store.notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
    }
    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { Task { await store.syncBanks() } } label: { Label("Sync banks", systemImage: "arrow.triangle.2.circlepath") }
                .disabled(store.busy)
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Text(store.workspace?.name ?? "")
                Toggle("Show bank sync results", isOn: $showBankSyncResults)
                Button("Refresh") { Task { await store.refresh() } }
                ForEach(store.workspaces.filter { $0.id != store.workspace?.id }) { workspace in
                    Button("Switch to \(workspace.name)") { Task { await store.select(workspace) } }
                }
                Button("Sign out", role: .destructive) { Task { await store.signOut() } }
            } label: { Label("Account", systemImage: "person.crop.circle") }
            .disabled(store.busy)
        }
    }
    private func row(_ transaction: ReviewTransaction) -> some View {
        let sign = transaction.transactionType == "income" ? "+" : transaction.transactionType == "expense" ? "−" : ""
        let category = store.categories.first(where: { $0.id == transaction.categoryId })?.name ?? "No category"
        let status = reviewStatus(transaction)
        return HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(store.payees.first(where: { $0.id == transaction.payeeId })?.name ?? transaction.payeeName ?? "Transfer")
                    .font(.headline).foregroundStyle(.primary)
                Text("\(store.accounts.first(where: { $0.id == transaction.accountId })?.name ?? "Account") · \(transaction.transactionDate)")
                    .font(.caption).foregroundStyle(.secondary)
                Label(status.title, systemImage: status.icon)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(status.color)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(status.color.opacity(0.12), in: Capsule())
            }
            Spacer()
            VStack(alignment: .trailing) {
                Text("\(sign)\(formattedMoney(abs(transaction.amountMinor), currency: transaction.currency))").monospacedDigit()
                Text(category).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .foregroundStyle(.primary)
        }
        .padding(.vertical, 4)
    }

    private func reviewStatus(_ transaction: ReviewTransaction) -> (title: String, icon: String, color: Color) {
        switch store.reviewReadiness(for: transaction) {
        case .ready: return ("Ready to approve", "checkmark.circle.fill", .green)
        case .missingPayee: return ("Needs payee", "person.crop.circle.badge.questionmark", .orange)
        case .missingCategory: return ("Needs category", "tag.slash.fill", .orange)
        case .missingPayeeAndCategory: return ("Needs payee & category", "exclamationmark.circle.fill", .orange)
        }
    }
}

private struct LiveCandidateView: View {
    @ObservedObject var store: LiveExpenseStore
    let candidate: ReviewTransaction
    @Environment(\.dismiss) private var dismiss
    @State private var payeeId: UUID?
    @State private var categoryId: UUID?
    @State private var memo: String
    @State private var error: String?
    @State private var rejecting = false
    @State private var applyingSuggestion = false
    @State private var rememberCategory: Bool
    @State private var rememberMapping = true
    @State private var showingTransfer = false
    @State private var transferAccountId: UUID?

    init(store: LiveExpenseStore, candidate: ReviewTransaction) {
        self.store = store
        self.candidate = candidate
        _payeeId = State(initialValue: candidate.payeeId)
        _categoryId = State(initialValue: store.categories.contains(where: { $0.id == candidate.categoryId }) ? candidate.categoryId : nil)
        _memo = State(initialValue: candidate.memo ?? "")
        let payee = store.payees.first(where: { $0.id == candidate.payeeId })
        _rememberCategory = State(initialValue: candidate.payeeId != nil && payee?.defaultCategoryId != candidate.categoryId)
        _transferAccountId = State(initialValue: store.eligibleTransferAccounts(for: candidate).first?.id)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Imported transaction") {
                    LabeledContent("Account", value: store.accounts.first(where: { $0.id == candidate.accountId })?.name ?? "Unknown account")
                    LabeledContent("Amount", value: formattedMoney(candidate.amountMinor, currency: candidate.currency))
                    LabeledContent("Type", value: candidate.transactionType.capitalized)
                    LabeledContent("Date", value: candidate.transactionDate)
                    Text(candidate.payeeName ?? "Unknown payee")
                    if let bankMemo = candidate.bankMemo, !bankMemo.isEmpty {
                        LabeledContent("Bank memo", value: bankMemo).foregroundStyle(.secondary)
                    }
                }
                Section("Review details") {
                    NavigationLink {
                        SearchablePayeePicker(payees: store.payees, selection: $payeeId) { name in
                            try await store.createPayee(name: name, categoryId: categoryId, accountId: candidate.accountId)
                        }
                    } label: {
                        LabeledContent("Payee", value: store.payees.first(where: { $0.id == payeeId })?.name ?? "Use imported payee")
                    }
                    .onChange(of: payeeId) { _, nextPayeeId in
                        rememberCategory = nextPayeeId != nil
                        rememberMapping = nextPayeeId != nil
                        if let defaultCategory = store.payees.first(where: { $0.id == nextPayeeId })?.defaultCategoryId,
                           store.categories.contains(where: { $0.id == defaultCategory }) { categoryId = defaultCategory }
                    }
                    Picker("Category", selection: $categoryId) {
                        Text("Select category").tag(nil as UUID?)
                        ForEach(store.categories) { Text($0.name).tag(Optional($0.id)) }
                    }
                    TextField("What was this purchase for?", text: $memo, axis: .vertical)
                        .lineLimit(1...4)
                    .onChange(of: categoryId) { _, nextCategoryId in
                        if let payeeId, let nextCategoryId,
                           store.payees.first(where: { $0.id == payeeId })?.defaultCategoryId != nextCategoryId { rememberCategory = true }
                    }
                    if let payeeId,
                       store.payees.first(where: { $0.id == payeeId })?.defaultCategoryId != categoryId {
                        Toggle("Make this the default category for \(store.payees.first(where: { $0.id == payeeId })?.name ?? "this payee")", isOn: $rememberCategory)
                    }
                    if shouldOfferMapping {
                        Toggle("Remember “\(candidate.payeeName ?? "")” as an alternative name", isOn: $rememberMapping)
                    }
                }.disabled(store.busy)
                if let suggestion = store.possiblePayeeMatch(for: candidate), payeeId == nil {
                    Section("Possible payee match") {
                        Label(suggestion.payee.name, systemImage: "sparkles")
                        Text("“\(suggestion.mapping.sourceName)” matches the start of the bank \(suggestion.sourceIsMemo ? "memo" : "description").")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("Use Starts with and select payee") {
                            Task {
                                applyingSuggestion = true; defer { applyingSuggestion = false }
                                do {
                                    try await store.promotePayeeMapping(suggestion)
                                    payeeId = suggestion.payee.id
                                    rememberMapping = false
                                } catch { self.error = error.localizedDescription }
                            }
                        }
                        Button("Add to alternative names and select payee") {
                            Task {
                                applyingSuggestion = true; defer { applyingSuggestion = false }
                                do {
                                    try await store.addAlternativeName(suggestion.sourceText, payee: suggestion.payee, accountId: candidate.accountId)
                                    payeeId = suggestion.payee.id
                                    rememberMapping = false
                                } catch { self.error = error.localizedDescription }
                            }
                        }
                    }.disabled(store.busy || applyingSuggestion)
                }
                if let suggestedAccount = store.suggestedTransferAccount(for: candidate) {
                    Section("Possible transfer match") {
                        Button("Match existing transfer to \(suggestedAccount.name)") {
                            Task {
                            do { try await store.approveAsTransfer(candidate, counterpartyAccountId: suggestedAccount.id, memo: memo); dismiss() }
                                catch { self.error = error.localizedDescription }
                            }
                        }
                    }.disabled(store.busy)
                }
                if !store.eligibleTransferAccounts(for: candidate).isEmpty {
                    Section("Transfer") {
                        DisclosureGroup("Post as transfer", isExpanded: $showingTransfer) {
                            Picker(candidate.transactionType == "expense" ? "Transfer to" : "Transfer from", selection: $transferAccountId) {
                                ForEach(store.eligibleTransferAccounts(for: candidate)) { account in
                                    Text(account.name).tag(Optional(account.id))
                                }
                            }
                            Button("Post transfer") {
                                guard let transferAccountId else { return }
                                Task {
                                    do { try await store.approveAsTransfer(candidate, counterpartyAccountId: transferAccountId, memo: memo); dismiss() }
                                    catch { self.error = error.localizedDescription }
                                }
                            }.disabled(transferAccountId == nil || store.busy)
                        }
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
                Section {
                    Button("Approve") {
                        Task {
                            do {
                                try await store.approve(candidate, payeeId: payeeId, categoryId: categoryId, memo: memo,
                                                       rememberCategory: rememberCategory,
                                                       rememberMapping: shouldOfferMapping && rememberMapping)
                                dismiss()
                            }
                            catch { self.error = error.localizedDescription }
                        }
                    }.disabled(store.busy || categoryId == nil)
                    Button("Reject", role: .destructive) { rejecting = true }.disabled(store.busy)
                    if store.busy { ProgressView("Saving…") }
                }
            }
            .navigationTitle("Review transaction")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(store.busy) } }
            .interactiveDismissDisabled(store.busy)
            .confirmationDialog("Reject this imported transaction?", isPresented: $rejecting, titleVisibility: .visible) {
                Button("Reject transaction", role: .destructive) {
                    Task {
                        do { try await store.reject(candidate); dismiss() }
                        catch { self.error = error.localizedDescription }
                    }
                }
            }
            .onChange(of: store.signedIn) { _, value in if !value { dismiss() } }
        }
    }

    private var shouldOfferMapping: Bool {
        guard let payeeId, payeeId != candidate.payeeId,
              let source = candidate.payeeName?.trimmingCharacters(in: .whitespacesAndNewlines), !source.isEmpty else { return false }
        let normalized = source.precomposedStringWithCompatibilityMapping.lowercased()
        return !store.payeeMappings.contains {
            $0.payeeId == payeeId && $0.sourceName.precomposedStringWithCompatibilityMapping
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == normalized
        }
    }
}

private struct SearchablePayeePicker: View {
    let payees: [ReviewPayee]
    @Binding var selection: UUID?
    let onCreate: (String) async throws -> ReviewPayee
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var creating = false
    @State private var error: String?

    private var filtered: [ReviewPayee] {
        let cleaned = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? payees : payees.filter { $0.name.localizedStandardContains(cleaned) }
    }

    var body: some View {
        List {
            Button {
                selection = nil; dismiss()
            } label: {
                HStack { Text("Use imported payee"); Spacer(); if selection == nil { Image(systemName: "checkmark") } }
            }
            ForEach(filtered) { payee in
                Button {
                    selection = payee.id; dismiss()
                } label: {
                    HStack { Text(payee.name); Spacer(); if selection == payee.id { Image(systemName: "checkmark") } }
                }
            }
            let cleaned = query.trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty && !payees.contains(where: { $0.name.compare(cleaned, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }) {
                Button {
                    Task {
                        creating = true; defer { creating = false }
                        do {
                            let payee = try await onCreate(cleaned)
                            selection = payee.id
                            dismiss()
                        } catch { self.error = error.localizedDescription }
                    }
                } label: { Label("Create “\(cleaned)”", systemImage: "plus") }
                    .disabled(creating)
            }
            if filtered.isEmpty { ContentUnavailableView.search(text: query) }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Select payee")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Filter payees")
    }
}

private struct LiveBudgetRow: View {
    let item: LiveBudget.Category
    let currency: String
    private var color: Color {
        let raw = (item.category.color ?? "").trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: "")
        let hex = raw.count == 6 ? UInt32(raw, radix: 16) ?? 0x5D7D91 : 0x5D7D91
        return Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: item.category.symbol).font(.title3).foregroundStyle(color)
                .frame(width: 36, height: 36).background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(item.category.name).font(.headline).foregroundStyle(.primary)
                Text("\(formattedMoney(item.spent, currency: currency)) of \(formattedMoney(item.budget, currency: currency))")
                    .font(.subheadline).foregroundStyle(.secondary)
                ProgressView(value: min(max(item.fraction, 0), 1))
                    .tint(!item.category.isIncome && item.spent > item.budget ? .orange : color)
                if item.budget > 0 {
                    Text("\(item.fraction * 100, specifier: "%.0f")% \(item.category.isIncome ? "received" : "used") · \(formattedMoney(abs(item.budget - item.spent), currency: currency)) \(item.spent > item.budget ? "over budget" : "remaining")")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(item.spent > 0 ? "No budget · \(formattedMoney(item.spent, currency: currency)) \(item.category.isIncome ? "received" : "spent")" : "No budget")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if item.category.hidden == true { Text("Hidden category").font(.caption).foregroundStyle(.secondary) }
            }
        }.padding(.vertical, 6)
    }
}

private struct LiveBudgetCategoryView: View {
    @ObservedObject var store: LiveExpenseStore
    let categoryId: UUID
    private var item: LiveBudget.Category? { store.budget?.groups.flatMap { $0.categories }.first { $0.id == categoryId } }
    var body: some View {
        List {
            if let item, let budget = store.budget {
                Section(budget.monthTitle) { LiveBudgetRow(item: item, currency: budget.currency) }
                Section("Transactions this month") {
                    if item.transactions.isEmpty { Text("No transactions this month.").foregroundStyle(.secondary) }
                    ForEach(item.transactions) { transaction in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(alignment: .top) {
                                Text(store.payees.first { $0.id == transaction.payeeId }?.name ?? transaction.payeeName ?? "Unknown payee").font(.headline)
                                Spacer()
                                Text("\(transaction.transactionType == "income" ? "+" : "−")\(formattedMoney(transaction.amountMinor, currency: transaction.currency))").monospacedDigit()
                            }
                            Text("\(transaction.transactionDate) · \(store.accounts.first { $0.id == transaction.accountId }?.name ?? "Account")").font(.caption).foregroundStyle(.secondary)
                            if let memo = transaction.memo, !memo.isEmpty { Text(memo).font(.caption).foregroundStyle(.secondary) }
                        }.padding(.vertical, 4)
                    }
                }
            } else {
                Text(store.budgetError ?? "This category is no longer available. Pull to refresh.")
            }
        }
        .navigationTitle(item?.category.name ?? "Category")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
    }
}
