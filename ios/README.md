# Next Expense for iOS

A SwiftUI companion for reviewing real imported bank transactions in the same
Neon workspace as the web app. Requires Xcode 16+ and iOS 17+.

## Google rollout status

The native Google flow is implemented and covered by fixture tests. Production
activation is still blocked: on September 13, 2026, the Neon console did not
persist either `com.fraisejr.nextexpense://auth` or the full callback URI, and
`sign-in/social` returned `403 INVALID_CALLBACKURL`. Do not treat the button as
production-verified until callback registration succeeds and an interactive
Google sign-in completes. The application reports this setup issue explicitly.

An HTTPS callback alternative has been built and saved privately in Sites but
has not been published or connected to the app. Its origin is
`https://next-expense-ios-auth.rainy-ibex-1088.chatgpt.site`; Neon accepted this
HTTPS origin. Publishing it and routing the one-time verifier through that
host requires the user's approval. Site ID:
`appgprj_6aa6e0e600e48191872c7ba1b00580c2`; saved version:
`appgprj_6aa6e0e600e48191872c7ba1b00580c2~appgver_dfdce4f7a9f881919b9d09cccb62e552`.
The prepared checkout is `/tmp/next-expense-auth-callback`.

## Run

Open `NextExpense.xcodeproj`, select the `NextExpense` scheme and an iPhone
simulator, and run. Choose **Continue with Google** and use the same Google account as the website.
Email/password sign-in is also available for accounts that use it. If you belong to multiple workspaces, choose one.

The public Auth and Data API endpoints in `NeonConfiguration.production` match
the web project's public configuration. To use another Neon branch, replace
both URLs together. Never add a database connection string, Neon management API
key, or GoCardless secret to the app.

## Real review workflow

1. Import bank transactions using **Sync now** in the web app.
2. Continue with Google on iOS and open **Review**. Pull to refresh if needed.
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

Google sign-in uses `ASWebAuthenticationSession`, the system browser sheet, with
Neon’s existing Google provider. A fresh per-attempt state is validated along
with the exact callback scheme, host, and path. The returned one-time
`neon_auth_session_verifier` is exchanged using the original challenge cookie
from `sign-in/social`; browser cookies and Google passwords are never copied
into the app. Cancellation leaves the user signed out without an error alert.

Neon Auth must allow the trusted redirect origin
`com.fraisejr.nextexpense://auth`. The callback path is `/callback`. The system
authentication session receives this scheme directly; no browser login page or
new Google client secret is hosted in the app. Keep this allowed origin when
configuring a new Neon branch.

The client uses Neon Auth sessions and the `set-auth-jwt`
response header (with `/token` fallback), matching the installed web SDK.
Cookies are saved only in the device Keychain, protected while the device is
locked and excluded from migration to another device. Passwords are not saved.
Requests use an ephemeral session with no disk cache. Auth cookies go only to
the Auth endpoint; only the JWT goes to the Data API. Redirects are refused.
Sign-out clears in-memory data and local credentials even if server revocation
fails, and reports that failure. RLS remains authoritative for workspace access.

The shipped UI contains real Review and Ledger tabs. The original Overview,
Accounts, and demo store remain available for SwiftUI previews and unit tests;
they are not presented as live financial data. Mobile bank sync,
bank linking, new payee entry, transfers, and overview reporting remain outside
this integration. Google-only accounts do not need to create a password.

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
Google tests also cover callback state/host validation, duplicate parameters,
challenge-bound verifier exchange, and restoration without replaying the verifier.
Tests never approve or reject production transactions.

For a live acceptance check, use your own linked account and an intended pending
transaction, then follow the five steps above. This requires an interactive
sign-in; mocked integration tests do not establish production authentication or
prove a particular live transaction was saved.
