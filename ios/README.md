# Next Expense for iOS

A deliberately small SwiftUI companion app for the Next Expense web project.

## What is included

- **Overview** with net worth, yearly spending progress, and category budgets.
- **Review** inbox where an imported transaction's payee and category can be changed before approval, or the transaction can be rejected.
- **Accounts** with balances, last-sync state, and a Sync now action.
- Unit tests for budget calculations and the review/sync state transitions.

Manual transaction entry, budget administration, bank linking, and advanced reports are intentionally outside this first cut.

## Current data source

This first cut runs with sanitized in-memory demo data so the UI and interactions can be exercised before the production mobile API and authentication flow are chosen. Approval, rejection, and sync update the local demo state only; they do **not** affect Neon or GoCardless yet.

The integration seam is `NextExpense/App/ExpenseStore.swift`. The next step is to replace its local mutations with authenticated calls to a hosted API while retaining the same published state used by the views. GoCardless credentials and database credentials must remain on the server.

## Open and run

Requirements:

- macOS
- Xcode 16 or later
- iOS 17 or later

Open `NextExpense.xcodeproj`, select the `NextExpense` scheme and an iPhone simulator, then run the app.

From a Mac terminal, the project can be built and tested with:

```bash
cd ios
xcodebuild -project NextExpense.xcodeproj \
  -scheme NextExpense \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  test
```

The project uses only Apple frameworks and has no package dependencies.

## Repository validation

The lightweight validation available on any machine with Node.js is:

```bash
node ios/scripts/validate.mjs
```

This confirms that the project, its required MVP screens, tests, and scope guard are present. It is not a substitute for compiling and running the app with Xcode.
