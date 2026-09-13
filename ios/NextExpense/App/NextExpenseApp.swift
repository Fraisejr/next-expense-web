import SwiftUI

@main
struct NextExpenseApp: App {
    @StateObject private var store = ExpenseStore.demo()

    var body: some Scene {
        WindowGroup {
            TabView {
                OverviewView(store: store)
                    .tabItem { Label("Overview", systemImage: "chart.bar.fill") }

                ReviewInboxView(store: store)
                    .tabItem { Label("Review", systemImage: "tray.full.fill") }
                    .badge(store.candidates.count)

                AccountsView(store: store)
                    .tabItem { Label("Accounts", systemImage: "building.columns.fill") }
            }
            .tint(.teal)
        }
    }
}
