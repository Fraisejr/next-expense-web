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

                    NavigationStack {
                        List {
                            messages
                            Section("Recent 50 transactions") {
                                if store.ledger.isEmpty { Text("No transactions yet.").foregroundStyle(.secondary) }
                                ForEach(store.ledger) { transaction in
                                    VStack(alignment: .leading, spacing: 5) {
                                        row(transaction)
                                        if let category = store.categories.first(where: { $0.id == transaction.categoryId }) {
                                            Text(category.name).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                        }
                        .navigationTitle("Ledger")
                        .refreshable { await store.refresh() }
                        .toolbar { toolbar }
                    }
                    .tabItem { Label("Ledger", systemImage: "list.bullet.rectangle") }
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

    private var signIn: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Next Expense", systemImage: "chart.bar.fill").font(.title2.bold())
                    Text("Sign in with the same account you use on the web to review your bank transactions.")
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
