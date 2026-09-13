# Next Expense for iOS

A SwiftUI companion for reviewing real imported bank transactions in the same
Neon workspace as the web app. Requires Xcode 16+ and iOS 17+.

## Run

Open `NextExpense.xcodeproj`, select the `NextExpense` scheme and an iPhone
simulator, and run. Sign in with an existing Neon email/password account linked
to your web workspace. If you belong to multiple workspaces, choose one.

The public Auth and Data API endpoints in `NeonConfiguration.production` match
the web project's public configuration. To use another Neon branch, replace
both URLs together. Never add a database connection string, Neon management API
key, or GoCardless secret to the app.

## Real review workflow

1. Import bank transactions using **Sync now** in the web app.
2. Sign in on iOS and open **Review**. Pull to refresh if needed.
3. Open an item, choose an active category, and optionally choose a different
   existing payee. **Use imported payee** lets the existing server approval
   function resolve/create the payee using its established rules.
4. Approve. iOS calls the same `approve_bank_import_candidate` RPC as the web
   app. The database atomically creates/promotes the ledger transaction and
   marks the candidate approved. The inbox changes only after acknowledgement.
5. The saved transaction is fetched by its returned ID and appears in **Ledger**.
   Refresh the web ledger to see the same record there.

Rejection saves a server-side tombstone, preserving bank-sync deduplication.
The ledger normally displays the latest 50 transactions; a newly approved item
is shown immediately even when its date is older. Amounts retain their source
currency and transaction type; no mixed-currency totals are calculated.

Payee selection follows the web app's existing two-request contract: update the
pending candidate's payee, then approve. If approval fails, that payee change
may already be saved. Retrying uses the idempotent approval RPC; an ambiguous
network failure never triggers an automatic mutation retry. A server 401 causes
one session renewal and retry. A ledger reload failure after approval reports
that the approval was saved, rather than inviting duplicate submission.

## Authentication and scope

The client uses Neon Auth email sign-in, session cookies, and the `set-auth-jwt`
response header (with `/token` fallback), matching the installed web SDK.
Cookies are saved only in the device Keychain, protected while the device is
locked and excluded from migration to another device. Passwords are not saved.
Requests use an ephemeral session with no disk cache. Auth cookies go only to
the Auth endpoint; only the JWT goes to the Data API. Redirects are refused.
Sign-out clears in-memory data and local credentials even if server revocation
fails, and reports that failure. RLS remains authoritative for workspace access.

The shipped UI contains real Review and Ledger tabs. The original Overview,
Accounts, and demo store remain available for SwiftUI previews and unit tests;
they are not presented as live financial data. Google OAuth, mobile bank sync,
bank linking, new payee entry, transfers, and overview reporting remain outside
this integration. Google-only accounts need email/password configured through
the existing account flow before they can use this version.

## Verification

```bash
node ios/scripts/validate.mjs
xcodebuild -project ios/NextExpense.xcodeproj -scheme NextExpense \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.2' test
```

The Node check validates project structure only. XCTest exercises the demo
calculations and the live HTTP workflow through URLProtocol fixtures, including
workspace filters, cookie/JWT separation, token renewal, restoration, rejection,
failed approval, and a committed approval followed by a failed ledger fetch.
Tests never approve or reject production transactions.

For a live acceptance check, use your own linked account and an intended pending
transaction, then follow the five steps above. This requires an interactive
sign-in; mocked integration tests do not establish production authentication or
prove a particular live transaction was saved.
