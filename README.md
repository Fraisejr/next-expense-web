# Next Expense Web

A simple, local-first budgeting app for accounts, categories, income, expenses, budgets, and transfers.

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

## Local iOS imports

The importer accepts the tab-separated transaction and budget exports produced by the Next Expense iOS app:

```bash
npm run import:ios -- /path/to/transactions.txt /path/to/budgets.txt 2026-08
```

It generates `public/imported-data.local.json` and an audit report under `data/private/`. Both locations are ignored by Git because they contain personal financial data. When the local import is absent, the app starts with sanitized demo data.
