import SwiftUI

struct LiveExpenseView: View {
    @StateObject private var store = LiveExpenseStore()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("showBankSyncResults") private var showBankSyncResults = true
    @State private var email = ""
    @State private var password = ""
    @State private var selected: ReviewTransaction?

    var body: some View {
        Group {
            if !store.signedIn { signIn }
            else if store.workspace == nil { workspacePicker }
            else {
                TabView {
                    budgetTab
                    reportsTab
                    NavigationStack {
                        List {
                            messages
                            if store.candidates.isEmpty && !store.busy && store.errorMessage == nil {
                                ContentUnavailableView("You’re all caught up", systemImage: "checkmark.circle", description: Text("Tap Sync banks to check for new imports."))
                            }
                            ForEach(store.candidates) { candidate in
                                Button { selected = candidate } label: { row(candidate) }
                                    .disabled(store.busy)
                            }
                        }
                        .navigationTitle("Review")
                        .refreshable { await store.refresh() }
                        .toolbar { toolbar }
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
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(store.payees.first(where: { $0.id == transaction.payeeId })?.name ?? transaction.payeeName ?? "Transfer")
                    .font(.headline).foregroundStyle(.primary)
                Text("\(store.accounts.first(where: { $0.id == transaction.accountId })?.name ?? "Account") · \(transaction.transactionDate)")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing) {
                Text(formattedMoney(transaction.amountMinor, currency: transaction.currency)).monospacedDigit()
                Text(transaction.transactionType.capitalized).font(.caption).foregroundStyle(.secondary)
            }
            .foregroundStyle(.primary)
        }
        .padding(.vertical, 4)
    }
}

private struct LiveCandidateView: View {
    @ObservedObject var store: LiveExpenseStore
    let candidate: ReviewTransaction
    @Environment(\.dismiss) private var dismiss
    @State private var payeeId: UUID?
    @State private var categoryId: UUID?
    @State private var error: String?
    @State private var rejecting = false

    init(store: LiveExpenseStore, candidate: ReviewTransaction) {
        self.store = store
        self.candidate = candidate
        _payeeId = State(initialValue: candidate.payeeId)
        _categoryId = State(initialValue: store.categories.contains(where: { $0.id == candidate.categoryId }) ? candidate.categoryId : nil)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Imported transaction") {
                    LabeledContent("Amount", value: formattedMoney(candidate.amountMinor, currency: candidate.currency))
                    LabeledContent("Type", value: candidate.transactionType.capitalized)
                    LabeledContent("Date", value: candidate.transactionDate)
                    Text(candidate.payeeName ?? "Unknown payee")
                    if let memo = candidate.memo { Text(memo).foregroundStyle(.secondary) }
                }
                Section("Review details") {
                    Picker("Payee", selection: $payeeId) {
                        Text("Use imported payee").tag(nil as UUID?)
                        ForEach(store.payees) { Text($0.name).tag(Optional($0.id)) }
                    }
                    Picker("Category", selection: $categoryId) {
                        Text("Select category").tag(nil as UUID?)
                        ForEach(store.categories) { Text($0.name).tag(Optional($0.id)) }
                    }
                    Text("Hidden categories cannot be used. Transfers should be reviewed in the web app.")
                        .font(.footnote).foregroundStyle(.secondary)
                }.disabled(store.busy)
                if let error { Text(error).foregroundStyle(.red) }
                Section {
                    Button("Approve") {
                        Task {
                            do { try await store.approve(candidate, payeeId: payeeId, categoryId: categoryId); dismiss() }
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
