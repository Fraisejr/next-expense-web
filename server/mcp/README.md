# Next Expense MCP

A stateless Streamable HTTP MCP server for ChatGPT and Codex, hosted alongside
Next Expense on Vercel at `/api/mcp`. OAuth 2.1 authorization uses the existing
Neon sign-in and an explicit workspace consent screen. No OpenAI API key is needed.

## Tools

Read tools: `get_workspace`, `list_accounts`, `list_categories`, `list_payees`,
`list_transactions`, `spending_summary`, `list_budgets`, `list_time_codes`,
`read_timesheet`.

Write tools: `create_payee`, `create_transaction`, `update_transaction`, `set_budget`.
Writes require both `expenses:write` consent and current owner/member membership.
Viewer memberships can connect with `expenses:read` only. The server rechecks
membership and token expiry for every tool, including after consent.

Transaction searches are paginated (maximum 100 records per page) with inclusive
start/end dates. Read monetary values are decimal strings of integer minor units,
so large imported amounts remain exact. Write amounts must be safe integers.
Summaries separate currencies and exclude transfers and balance adjustments;
they describe posted income/expenses, not account balances. Budgets use the
workspace's default currency. No currency conversion is inferred.

Manual expense/income creation requires an account, matching category, payee,
and a stable transaction UUID. Retry with the same UUID and identical details;
conflicting retries fail instead of duplicating financial entries. Editing changes
date/category/payee/user memo only. Transfers, bank approvals, deletion, account
creation, and balance adjustments remain in the web/iOS app.

## Production setup

1. Apply migrations `db/migrations/074_expense_mcp.sql` and
   `db/migrations/075_fix_mcp_category_read.sql` using the local owner
   connection, after the existing migrations:

   ```sh
   node --env-file=.env.migration scripts/apply-migration.mjs db/migrations/074_expense_mcp.sql
   node --env-file=.env.migration scripts/apply-migration.mjs db/migrations/075_fix_mcp_category_read.sql
   node --env-file=.env.migration scripts/provision-mcp.mjs
   ```

   Provisioning creates `next_expense_mcp`, grants only `expense_mcp_runtime`,
   verifies that it cannot select financial tables directly, and writes the
   restricted credential to ignored `.env.mcp.local` with mode 0600. It refuses
   to replace an existing login. Keep the owner connection local.

2. Configure Vercel **server** environment variables:
   - `MCP_DATABASE_URL`: the restricted credential from `.env.mcp.local`.
   - `APP_URL`: the canonical origin, e.g. `https://next-expense-web.vercel.app`.
   - Existing `VITE_NEON_DATA_API_URL`: used to validate the signed-in user's
     token through Neon's Data API read-self membership policy.

   Never use `DATABASE_URL` or an owner credential as `MCP_DATABASE_URL`, and
   never prefix the MCP credential with `VITE_`. Deploy after setting variables.
   Preview environments need their own database and matching `APP_URL`.

3. Verify deployment routing:
   - `GET /.well-known/oauth-protected-resource/api/mcp` returns the resource.
   - `GET /.well-known/oauth-authorization-server` returns PKCE/DCR endpoints.
   - Unauthenticated `/api/mcp` returns 401 with `WWW-Authenticate` metadata.
   - `/oauth/consent` and `/oauth/connections` render the web app.
   - MCP and discovery endpoints must be reachable without Vercel login protection.

4. Connect ChatGPT using its custom MCP connection/plugin setup with OAuth and
   URL `https://next-expense-web.vercel.app/api/mcp`. Complete Neon sign-in and
   select the workspace. Account/workspace availability is controlled by ChatGPT.

5. Connect Codex:

   ```sh
   codex mcp add next-expense --url https://next-expense-web.vercel.app/api/mcp
   codex mcp login next-expense
   ```

   Or add the same remote URL in the desktop MCP settings. Never paste database
   credentials into ChatGPT, Codex config, or an MCP bearer-token field.

Visit `/oauth/connections` in Next Expense to disconnect clients at any time.
Revocation invalidates both access and refresh tokens immediately.

## OAuth and deployment behavior

This is a separate OAuth authorization server because Neon Auth does not provide
the Supabase OAuth flow used by Next Idea. Existing Neon identity is validated
through the Data API, then an opaque grant is bound to that immutable user ID
and one workspace. Financial access occurs only through the private, explicitly
scoped `expense_mcp.execute_tool` function. No browser-provided user ID is trusted.

OAuth supports dynamic public-client registration, exact registered redirect URI
matching, authorization code + mandatory S256 PKCE, one-use two-minute codes,
resource binding, one-hour access tokens, rotating refresh tokens with an absolute
30-day lifetime, and revocation. Tokens and codes are stored hashed. Requests
expire after ten minutes; client registrations expire after one year. Explicit
consent is required on every new authorization. HTTPS redirects and HTTP loopback
callbacks are supported. Client registration does not fetch arbitrary URLs.

OAuth state is persisted in the private `expense_mcp` schema, outside the public
Data API. Never expose this schema through Neon/PostgREST. Functions hold no
in-memory user sessions and work across Vercel replicas. The restricted login
holds private OAuth storage permissions and execute permission for the scoped
function; it has no direct financial-table privileges.

Periodically prune expired records and old revoked/expired grants using a trusted
maintenance connection. For a public multi-user rollout, configure edge rate
limits on registration/authorization/token endpoints and monitor failed exchanges.

## Validation

```sh
npm run test:mcp
npm run build
npm run lint
```

The PostgreSQL tests use a disposable local database only. To reproduce:
initialize local PostgreSQL, create `authenticated` and an `auth.user_id()` stub,
apply schema migrations through 020, add the `transactions.bank_memo` column from
068, and apply 074 and 075. Historical data-repair migrations expect production fixtures
and must not be run against an empty database. Run `scripts/test-mcp-database.sql`
with `psql -v ON_ERROR_STOP=1`; it rolls back its fixtures. For the OAuth integration
test, seed a separate disposable database with the fixture statements before
`set local role` in that SQL script, omitting `begin`, and run:

```sh
MCP_TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/TEST_DB npm run test:mcp
```

The integration test verifies registration, consent, resource/PKCE binding,
one-use authorization codes, refresh rotation, old-token rejection and revocation.
SQL tests verify real scoped reads/writes, retry safety, budget upserts, removal
of membership, and the runtime's lack of direct table access. These tests do not
establish an actual ChatGPT/Codex account's interactive login; verify that after
deploying with your own account.

Official references:
- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)
- [Codex MCP connections](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)


## Timesheet reads and weekly reporting

Apply `076_mcp_timesheet_reads.sql` before deploying this version. It adds the
private read function and optional Kleer project/activity mapping columns to time
codes. It grants no direct table access to the runtime. Existing `expenses:read`
connections can use the two new read tools; no timesheet write tool is exposed.
The web timesheet has a **Kleer reporting mappings** editor. Project and activity
must be filled together or both cleared. Kleer selects its customer from the
project, so customer is not stored as a separate destination mapping. Source
billing client names stay independent from destination projects.

`list_time_codes` lists all source codes, including hidden codes and inactive
clients, with IDs, names and saved `reporting_mapping` objects. An unmapped code
returns `reporting_mapping: null`. Both tools support `client_id` filtering.

`read_timesheet` accepts inclusive `start_date` and `end_date` (maximum 366 days),
optional `time_code_id`, and `limit`/`offset` (up to 100 entries per page). It
returns recorded positive hours only, with dates preserved as YYYY-MM-DD, exact
integer hours and minutes, source code/client IDs and names, source updated_at,
a stable workspace/code/date `entry_key`, the saved Kleer project/activity and
the corresponding `month_comment`/`comment_month`. Monthly notes describe a whole
month and must not be presented as verified daily work descriptions. No billing
rates or revenue forecasts are exposed.

The response includes full-range `total_entries`, `total_hours`, `total_minutes`,
`unmapped_entries`, a content `revision`, and an explicit nullable `next_offset`.
Pass the first page's revision on subsequent requests. Any change in the matching
entries, names, mappings or notes invalidates it; restart the read from offset 0.
Totals cover the whole filtered range and must not be added together across pages.

For a later weekly reporting task:

1. Determine the exact week dates and intended source codes/client.
2. Read every page with the same revision. Reconcile entry count and sum of hours
   against the full-range totals before copying anything.
3. Stop if `unmapped_entries` is nonzero. Use exact saved project/activity labels;
   never infer the Kleer customer from the source billing client.
4. Read existing destination rows and compare dates/project/activity/hours before
   writing, so reruns cannot duplicate hours. Flag ambiguous rows or differences.
   A locked report needs user attention; do not unlock it automatically.
5. Summarize what was copied and what remains unresolved. Only create a recurring
   task after its schedule, destination and reporting behavior have been agreed.

The current OAuth refresh-token lifetime is an absolute 30 days. Scheduled runs
must surface a reconnect requirement when authorization expires; authentication
failure must never be interpreted as an empty timesheet. Browser access to Kleer
is separate from the MCP connection and must also remain available to that task.

The real PostgreSQL regression test is `scripts/test-mcp-timesheet.sql`, using a
disposable local schema with 060, 064, 066, 074 and 076 applied. It checks complete
and filtered totals, hidden/inactive/unassigned work, cross-month notes, saved
mappings, page revisions, empty ranges, isolated workspaces, viewer read access,
expiry, revocation and removed memberships. All fixtures roll back.
