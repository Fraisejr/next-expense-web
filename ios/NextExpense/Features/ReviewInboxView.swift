import SwiftUI

struct ReviewInboxView: View {
    @ObservedObject var store: ExpenseStore
    @State private var selectedCandidate: BankImportCandidate?

    var body: some View {
        NavigationStack {
            Group {
                if store.candidates.isEmpty {
                    ContentUnavailableView(
                        "You’re all caught up",
                        systemImage: "checkmark.circle",
                        description: Text("Imported transactions awaiting approval will appear here.")
                    )
                } else {
                    List(store.candidates) { candidate in
                        Button {
                            selectedCandidate = candidate
                        } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(candidate.payee)
                                        .font(.headline)
                                        .foregroundStyle(.primary)
                                    Text("\(candidate.accountName) · \(candidate.date.formatted(date: .abbreviated, time: .omitted))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    if let note = candidate.note {
                                        Text(note)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Text(formattedMoney(candidate.amountMinor, currency: candidate.currency))
                                    .font(.subheadline.monospacedDigit())
                                    .foregroundStyle(.primary)
                            }
                            .padding(.vertical, 5)
                        }
                    }
                }
            }
            .navigationTitle("Review")
            .sheet(item: $selectedCandidate) { candidate in
                CandidateReviewView(store: store, candidate: candidate)
            }
        }
    }
}

private struct CandidateReviewView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: ExpenseStore
    let candidate: BankImportCandidate

    @State private var payee: String
    @State private var categoryID: UUID?
    @State private var errorMessage: String?
    @State private var approving = false
    @State private var showsRejectConfirmation = false

    init(store: ExpenseStore, candidate: BankImportCandidate) {
        self.store = store
        self.candidate = candidate
        _payee = State(initialValue: candidate.payee)
        _categoryID = State(initialValue: candidate.categoryID)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Imported transaction") {
                    LabeledContent("Amount", value: formattedMoney(candidate.amountMinor, currency: candidate.currency))
                    LabeledContent("Date", value: candidate.date.formatted(date: .long, time: .omitted))
                    LabeledContent("Account", value: candidate.accountName)
                }

                Section("Modify before approval") {
                    TextField("Payee", text: $payee)
                    Picker("Category", selection: $categoryID) {
                        Text("Select category").tag(nil as UUID?)
                        ForEach(store.categories) { category in
                            Text(category.name).tag(Optional(category.id))
                        }
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        approving = true
                        Task {
                            do {
                                try await store.approve(
                                    candidateID: candidate.id,
                                    payee: payee,
                                    categoryID: categoryID
                                )
                                dismiss()
                            } catch {
                                errorMessage = "Choose a payee and category before approving."
                                approving = false
                            }
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if approving { ProgressView() } else { Text("Approve") }
                            Spacer()
                        }
                    }
                    .disabled(approving)

                    Button("Reject", role: .destructive) {
                        showsRejectConfirmation = true
                    }
                }
            }
            .navigationTitle("Review transaction")
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog(
                "Reject this imported transaction?",
                isPresented: $showsRejectConfirmation,
                titleVisibility: .visible
            ) {
                Button("Reject transaction", role: .destructive) {
                    store.reject(candidateID: candidate.id)
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

#Preview {
    ReviewInboxView(store: .demo(syncDelayNanoseconds: 0))
}
