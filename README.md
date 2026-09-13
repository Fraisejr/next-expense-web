# Next Expense Web

A budgeting app for accounts, categories, income, expenses, budgets, and transfers.

## Development

```bash
npm install
npm run dev
```

Production builds can be verified with:

```bash
npm run build
```

## Money representation

All monetary values are stored as integer minor units (cents). Decimal conversion happens only at input and display boundaries, avoiding floating-point rounding errors in balances and budget calculations.

The home route combines a compact financial overview with monthly category planning. Its net-worth composition opens the account balance sheet, while its monthly profit-and-loss summary opens the detailed report. The former `/budgets` route remains compatible and shows the same combined view.

## Product data decisions

- Split transactions are intentionally unsupported. Migration must ignore legacy split components, including stale split amounts or category references, whenever importing iOS data.
- Multiple currencies are supported. Transactions and accounts retain their original currency instead of being coerced to EUR.
- Historical exchange rates are supported and must be preserved during migration for cross-currency balances, transfers, and reporting. Combined reports use the latest saved rate from the relevant month or earlier, while current balances use the latest saved rate available today.
- Exchange rates can be added, edited, and removed from Settings. Rates retain the legacy two-decimal format and are entered as quote currency per one unit of the workspace reporting currency.
- Recurring transaction generation is intentionally unsupported. Legacy recurrence metadata may be retained for audit purposes, but future-dated generated transactions are excluded from imports and rejected by the database.
- Every new income or expense transaction must have a category; new transfers must not have one. Historical transaction records remain untouched.
- Legacy savings and investment categories remain visible for historical activity and monthly targets. Their plans do not roll into later months and are not savings balances; current saved value comes from the balances of the accounts holding the money.
- The transaction ledger includes an all-time **Needs category** view for historical gaps. Any existing non-transfer transaction can be assigned or moved to an active category and linked to an existing or newly entered payee from its row. Payee choices show their saved default category, which can also be replaced while editing.

## Database

Production data lives in a dedicated Neon Postgres project. The versioned schema
is under `db/migrations/`. Neon Auth, the Data API, and workspace-membership
row-level security are configured, so signed-in users can only access workspaces
to which they have explicitly been linked.

The web app can run against Neon from localhost. Copy `.env.example` to
`.env.local` and use the project's public Auth and Data API URLs. Google sign-in
and email/password are both supported.

Never expose the Postgres connection string to Vite or prefix it with `VITE_`.
It is a server/migration credential only. Provider secrets follow the same rule.

## GoCardless bank linking

Open an active account in the web app and choose **Connect bank**. The local
server exchanges the server-only GoCardless credentials, lists institutions for
the selected country, creates the requisition, and receives the user after bank
authorization. The user then selects the returned provider account to attach to
the existing Next Expense account. Bank credentials are entered only on the
bank/GoCardless authorization pages and are never visible to Next Expense.

Connected accounts expose **Sync now**. A sync makes one transactions request
and one balances request, imports only booked transactions after the persisted
legacy-migration cutoff, deduplicates later requests by provider ID, and updates
the account to the bank-reported balance. The most recent successful sync and
rate-limit information are stored on the bank connection. Merely opening an
account does not request bank data.

Bank counterparties can be mapped to owned accounts for transfer detection.
Matching is conservative: direction, currency, amount, a unique date-near
candidate, and the counterparty alias must agree. Provider references are kept
per account-side so a single logical transfer can retain the different IDs
reported by both banks. Unlinked bank legs are reconsidered after later syncs.

Each connected account can either add categorized bank transactions automatically
or hold them for review. Review mode is the default. Approvals require a category
and create ledger rows atomically; the chosen category can be remembered on the
payee for future imports. In automatic mode, only transactions with a visible
saved category enter the ledger, while the rest wait for review. A hidden saved
category is shown as a warning so it can be replaced on the payee or unhidden
before approval. Rejections remain as provider-ID tombstones so later syncs do
not offer them again. Exact duplicates and confident transfers bypass the inbox
and continue to reconcile automatically in either mode.

Transactions retain both GoCardless's `internalTransactionId` as the canonical
provider identifier and the financial institution's `transactionId` as a
secondary audit and deduplication identifier.

## Vercel deployment

Production: https://next-expense-web.vercel.app

`api/gocardless/[action].ts` runs the shared bank handler on Vercel;
`server/gocardless-dev.ts` exposes it in local Vite development. Both require a
Neon bearer JWT and workspace membership. Bank reads also verify the account
against the provider's signed authorization reference, because account and
connection rows are editable by workspace members. Older bank links must be
reconnected once using **Reconnect** before hosted sync can run. Existing ledger
and imported transactions are preserved.

Vercel production environment variables:
- `VITE_NEON_AUTH_URL` and `VITE_NEON_DATA_API_URL`: public Neon endpoints.
- `GOCARDLESS_SECRET_ID` and `GOCARDLESS_SECRET_KEY`: server-only secrets.
- `APP_URL`: `https://next-expense-web.vercel.app`, used for bank return URLs.

Deploy source with `vercel deploy --prod` from the linked project. GitHub is
connected for subsequent pushes. The build excludes local finance archives;
`.vercelignore` also excludes `.env`, local imports, and the native project.
Only the public authentication assets are copied from `public` into production.

Neon Auth must trust the production HTTPS origin. `/auth/ios/callback` forwards
only the one-time verifier and validated state to the iOS app's fixed callback
scheme. The page uses no storage or analytics and sends no-referrer/no-store
headers. See `ios/README.md` for the native authentication flow.

Verification: `npm run build`, `npm run lint`, `npm run test:server`, and
`npm run test:ios-callback`. Server tests use fixtures, never real bank reads or
production transaction approvals.

## Full iOS archive imports

The versioned iOS archive importer validates relationships, preserves stable
iOS UUIDs and provider transaction IDs, and upserts records so future exports
can be applied as delta migrations. It never deletes database rows merely
because a later export omits them.

Later iOS exports may update user-maintained account details, but they do not
overwrite web-managed bank connections, sync timestamps, automatic-sync state,
or balance reconciliation adjustments.

Dates are derived from source timestamps in `Europe/Paris`. This is important
for timestamps near midnight: slicing the UTC timestamp would place many
transactions on the previous calendar day. Transactions later than today's
`Europe/Paris` date are excluded so legacy recurring entries cannot distort
current account balances.

Dry-run an archive first:

```bash
npm run import:ios:archive -- /path/to/next-expense-export-v1.json
```

Apply it using a server-only connection string:

```bash
DATABASE_URL='postgresql://...' npm run import:ios:archive -- /path/to/next-expense-export-v1.json --apply
```

The private validation report is written under `data/private/`, which is
ignored by Git. Legacy split components are deliberately excluded, as are
orphaned records that refer to entities already deleted in the iOS store.

## Legacy tab-separated iOS imports

The importer accepts the tab-separated transaction and budget exports produced by the Next Expense iOS app:

```bash
npm run import:ios -- /path/to/transactions.txt /path/to/budgets.txt 2026-08
```

It generates `public/imported-data.local.json` and an audit report under `data/private/`. Both locations are ignored by Git because they contain personal financial data. When the local import is absent, the app starts with sanitized demo data.

Zero-value bank entries are retained as rejected review records with
`decision_reason=zero_amount`. Their provider IDs and raw payload remain intact.
A later nonzero update with the same ID reopens the entry for review; manual
rejections remain rejected. Apply migration 065 before deploying this behavior.
Verify the transition policy with `npm run test:bank-policy`.
