import SwiftUI

struct AccountsView: View {
    @ObservedObject var store: ExpenseStore

    var body: some View {
        NavigationStack {
            List(store.accounts) { account in
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(account.name)
                                .font(.headline)
                            Text(formattedMoney(account.balanceMinor, currency: account.currency))
                                .font(.subheadline.monospacedDigit())
                        }
                        Spacer()
                        if account.isConnected {
                            Label("Connected", systemImage: "checkmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(.green)
                        }
                    }

                    HStack {
                        if let lastSyncedAt = account.lastSyncedAt {
                            Text("Last synced \(lastSyncedAt, style: .relative)")
                        } else {
                            Text("Last synced: Never")
                        }
                        Spacer()
                        Button {
                            Task { await store.sync(accountID: account.id) }
                        } label: {
                            if store.syncingAccountID == account.id {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
                            }
                        }
                        .buttonStyle(.bordered)
                        .disabled(!account.isConnected || store.syncingAccountID != nil)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(.vertical, 5)
            }
            .navigationTitle("Accounts")
        }
    }
}

#Preview {
    AccountsView(store: .demo(syncDelayNanoseconds: 0))
}
