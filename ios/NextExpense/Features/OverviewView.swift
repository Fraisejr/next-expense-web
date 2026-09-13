import SwiftUI

struct OverviewView: View {
    @ObservedObject var store: ExpenseStore

    private var currency: String {
        store.categories.first?.currency ?? store.accounts.first?.currency ?? "EUR"
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Net worth")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(formattedMoney(store.netWorthMinor, currency: currency))
                            .font(.system(.title, design: .rounded, weight: .semibold))
                    }
                    .padding(.vertical, 6)

                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Year spending")
                            Spacer()
                            Text(formattedMoney(store.yearSpentMinor, currency: currency))
                                .fontWeight(.semibold)
                        }
                        ProgressView(
                            value: min(Double(store.yearSpentMinor), Double(store.yearSpendingGoalMinor)),
                            total: Double(max(store.yearSpendingGoalMinor, 1))
                        )
                        Text(
                            store.yearSpentMinor > store.yearSpendingGoalMinor
                                ? "Over by \(formattedMoney(store.yearSpentMinor - store.yearSpendingGoalMinor, currency: currency))"
                                : "\(formattedMoney(store.yearSpendingGoalMinor - store.yearSpentMinor, currency: currency)) remaining of this year’s goal"
                        )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }

                Section("Budget") {
                    ForEach(store.categories) { category in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(category.name)
                                    .fontWeight(.medium)
                                Spacer()
                                Text(formattedMoney(category.spentMinor, currency: category.currency))
                                    .font(.subheadline.monospacedDigit())
                            }
                            ProgressView(value: category.progress)
                                .tint(category.isOverBudget ? .red : .teal)
                            HStack {
                                Text("of \(formattedMoney(category.budgetMinor, currency: category.currency))")
                                Spacer()
                                Text(category.isOverBudget ? "Over by \(formattedMoney(-category.remainingMinor, currency: category.currency))" : "\(formattedMoney(category.remainingMinor, currency: category.currency)) left")
                                    .foregroundStyle(category.isOverBudget ? .red : .secondary)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 5)
                    }
                }

                Section {
                    Label("Demo data — server connection comes next", systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Next Expense")
        }
    }
}

#Preview {
    OverviewView(store: .demo(syncDelayNanoseconds: 0))
}
