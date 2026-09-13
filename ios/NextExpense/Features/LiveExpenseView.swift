import SwiftUI

struct LiveExpenseView: View {
    @StateObject private var store = LiveExpenseStore()
    @Environment(\.scenePhase) private var scenePhase
    @State private var email = ""
    @State private var password = ""
    @State private var selected: ReviewTransaction?

    var body: some View {
        Group {
            if !store.signedIn { signIn }
            else if store.workspace == nil { workspacePicker }
            else {
                TabView {
                    reportsTab
                    NavigationStack {
                        List {
                            messages
                            if store.candidates.isEmpty && !store.busy && store.errorMessage == nil {
                                ContentUnavailableView("You’re all caught up", systemImage: "checkmark.circle", description: Text("Sync your bank in the web app, then pull to refresh here."))
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
        if store.busy { ProgressView("Updating…") }
        if let error = store.errorMessage {
            Section { Text(error).foregroundStyle(.red); Button("Retry") { Task { await store.refresh() } }.disabled(store.busy) }
        }
        if let notice = store.notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
    }
    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Text(store.workspace?.name ?? "")
                Button("Refresh") { Task { await store.refresh() } }
                ForEach(store.workspaces) { workspace in
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
