# Next Expense for iOS

A SwiftUI companion for reviewing real imported bank transactions in the same
Neon workspace as the web app. Requires Xcode 16+ and iOS 17+.

## Google rollout status

The HTTPS callback is deployed at
`https://next-expense-web.vercel.app/auth/ios/callback`, and its origin is
registered in Neon Auth. The live `sign-in/social` endpoint accepts this callback
and issues a session challenge. The native app and callback validation tests
pass. Full interactive Google sign-in still needs a user acceptance check;
fixture tests do not establish that an individual account can complete login.

Rebuild the app to use this HTTPS callback, then choose **Continue with Google**.
Google-only accounts do not need to create a password.

## Run

Open `NextExpense.xcodeproj`, select the `NextExpense` scheme and an iPhone
simulator, and run. Choose **Continue with Google** and use the same Google account as the website.
Email/password sign-in is also available for accounts that use it. If you belong to multiple workspaces, choose one.

The public Auth and Data API endpoints in `NeonConfiguration.production` match
the web project's public configuration. To use another Neon branch, replace
both URLs together. Never add a database connection string, Neon management API
key, or GoCardless secret to the app.

## Real review workflow

1. Continue with Google on iOS and tap **Sync banks** in Reports or Review.
2. Each open, connected account syncs sequentially and shows its result. Reports
   and Review refresh afterward, including when one account fails.
3. Open an item, choose an active category, and optionally search for a different
   payee or create one from the search field. When an exact payee mapping is a prefix of the imported name
   or memo, iOS offers the same **Use Starts with and select payee** and **Add to
   alternative names and select payee** actions as the web app. **Use imported
   payee** lets the existing server approval function resolve/create the payee
   using its established rules.
4. Optionally save a changed category as the payee default and remember a
   manually selected payee as an alternative name. New mappings immediately
   rematch the other pending imports for that account.
5. Approve. iOS calls the same `approve_bank_import_candidate` RPC as the web
   app. The database atomically creates/promotes the ledger transaction and
   marks the candidate approved. The inbox changes only after acknowledgement.
6. Reports refresh after the approval commits. Refresh the web app to see the
   same saved result there.

An item that already has an active category and either a saved payee or a usable
imported payee name can also be approved by swiping right from the Review list.
Possible existing transfers are suggested when a same-currency transfer has the
same amount within three days. Any imported item can also be posted as a new
transfer to or from another open account in the same currency.

Rejection saves a server-side tombstone, preserving bank-sync deduplication.
Reports show current net worth and year-to-date personal plus company expenses
against the saved combined annual spending goal. Net worth uses the same balance
RPC as the web, including balance checkpoints and liabilities, and excludes
closed accounts. Expenses use expense report groups, net of refunds, excluding
taxes, transfers and unapproved imports. Currency conversion follows the latest
saved rate from the transaction month or earlier; missing rates produce an error
instead of silently understating totals. The reporting year uses Europe/Paris.

Payee selection follows the web app's existing two-request contract: update the
pending candidate's payee, then approve. If approval fails, that payee change
may already be saved. Retrying uses the idempotent approval RPC; an ambiguous
network failure never triggers an automatic mutation retry. A server 401 or explicit JWT-expired response causes
one session renewal and retry. The client also renews JWTs within 30 seconds
of expiry before sending a data request. A report reload failure after approval reports
that the approval was saved, rather than inviting duplicate submission.

## Authentication and scope

Google sign-in uses `ASWebAuthenticationSession`, the system browser sheet, with
Neon’s existing Google provider. A fresh per-attempt state is validated along
with the exact callback scheme, host, and path. The returned one-time
`neon_auth_session_verifier` is exchanged using the original challenge cookie
from `sign-in/social`; browser cookies and Google passwords are never copied
into the app. Cancellation leaves the user signed out without an error alert.

Neon Auth must trust `https://next-expense-web.vercel.app`. Its
`/auth/ios/callback` page forwards the one-time verifier and state to
`com.fraisejr.nextexpense://auth/callback`, which the system authentication
session receives. The callback destination is fixed, its query is immediately
removed from browser history, and it uses no storage or analytics. The native
app exchanges the verifier with its original challenge cookie. Keep the HTTPS
origin registered when configuring a new Neon branch.

The client uses Neon Auth sessions and the `set-auth-jwt`
response header (with `/token` fallback), matching the installed web SDK.
Cookies are saved only in the device Keychain, protected while the device is
locked and excluded from migration to another device. Passwords are not saved.
Requests use an ephemeral session with no disk cache. Auth cookies go only to
the Auth endpoint; only the JWT goes to the Data API. Redirects are refused.
Sign-out clears in-memory data and local credentials even if server revocation
fails, and reports that failure. RLS remains authoritative for workspace access.

The app opens on a read-only Budget tab, followed by Reports and Review.
Budget shows the current month by saved category group and category order, with
saved colors/icons, net spending, monthly overrides (or default budgets), and
uncapped usage percentages. Tap a category to see its current-month transactions;
there are no editing controls. Hidden categories are excluded. The month appears discreetly beneath the compact
Budget navigation title.
Bank sync results can be hidden using **Hide** and restored using **Show bank sync
results** in the account menu; this preference persists across launches.

The shipped UI contains real Budget, Reports and Review tabs. The original Overview,
Accounts, and demo store remain available for SwiftUI previews and unit tests;
they are not presented as live financial data. Bank linking and reconnection
remain on the website. Google-only accounts do not need to create a password.

Bank sync calls the fixed HTTPS `/api/gocardless/sync-import` endpoint using a
fresh Neon JWT. Auth cookies and provider secrets never go to that endpoint.
The server applies the same import mode, matching, zero-value exclusions and
Review staging used by the web client. Network failures do not retry imports;
refresh to see any saved results. Reconnect expired consents on the website.

## Verification

```bash
node ios/scripts/validate.mjs
xcodebuild -project ios/NextExpense.xcodeproj -scheme NextExpense \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.2' test
```

The Node check validates project structure only. XCTest exercises the demo
calculations and the live HTTP workflow through URLProtocol fixtures, including
workspace filters, cookie/JWT separation, token renewal, restoration, rejection,
failed approval, and a committed approval followed by a failed report fetch.
Google tests also cover callback state/host validation, duplicate parameters,
challenge-bound verifier exchange, and restoration without replaying the verifier.
Tests never approve or reject production transactions.

For a live acceptance check, use your own linked account and an intended pending
transaction, then follow the five steps above. This requires an interactive
sign-in; mocked integration tests do not establish production authentication or
prove a particular live transaction was saved.

The first report emphasizes spending pace: actual year-to-date expenses versus
the combined annual goal prorated by calendar days elapsed, including today.
It highlights the amount above or below this target and shows actual and target
bars on the same scale. Leap years use 366 days. Net worth appears below it.
