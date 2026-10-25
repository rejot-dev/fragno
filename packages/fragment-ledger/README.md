# @fragno-dev/ledger

A double-entry ledger as a Fragno fragment: fiscal years and periods, a chart of accounts, journals,
dimensions, parties, posted entries, open items and their settlement, and per-period account
balances. One ledger per database (or namespace): Bookkeeping gives each administration its own.

Amounts are integers in minor units: bigints in services and the database, and strings of digits
over HTTP, where JSON numbers would be exact only to 2^53. A line or allocation has at most fifteen
digits of minor units, so balances, sums of many amounts, stay exact and within 64-bit integers.

## Rules

Fragno schemas have no triggers or check constraints, so the ledger's services enforce its rules
before they write, and nothing else writes:

- **Posted means final.** Entries are validated in full and written posted; there are no drafts and
  no update or delete. A reversal corrects an entry: it posts every line again with its side
  swapped, in the same journal and for the same source document, at most once per entry. Reversals
  skip account and dimension rules, so an entry stays reversible after its accounts change.
- **References are unique per journal.** An entry's optional reference, such as an invoice number,
  is refused when the journal already has it, so posting the same entry again cannot post it twice.
- **Entries balance** in the functional currency and have at least two lines. A line in the
  functional currency has one amount; a foreign line carries both its amount and its functional
  amount.
- **Accounts** accept lines while active and, when they have a currency, only in that currency.
  Their dimension rules make a dimension required or forbidden. Classification, normal side, and
  currency never change, so posted history keeps its meaning.
- **Control accounts.** Receivable and payable accounts take only lines that are open items of a
  party account posting to them; other accounts take none.
- **Calendar.** Fiscal years follow each other without gaps, and a year's periods partition it, so a
  posting date has at most one period, which must be open. Periods move open ⇄ closed → locked.
- **Parties** are created with their first customer or supplier account, so a refused account leaves
  no party behind.
- **Settlement** allocates a debit open item against a credit one of the same party account and
  currency, within both outstanding amounts; without an amount it settles all both have outstanding.
  Allocations are append-only; a reversal undoes one.

Rules that span rows use optimistic concurrency: the journal's last entry number, open items'
outstanding amounts, and balances are updated with version checks, and posting checks the versions
of the period and accounts it validated against. A concurrent conflict retries the transaction.
Fiscal years claim a unique number, so two concurrent years conflict too.

## Use

```ts
import { createLedgerFragment } from "@fragno-dev/ledger";

const ledger = createLedgerFragment({ databaseAdapter });
```

`src/routes.ts` declares the HTTP API. A refused operation answers a `LedgerErrorCode` from
`@fragno-dev/ledger/errors`. The same operations are services, for composing in one transaction;
they throw `LedgerError`.

## Tests

`pnpm test` runs scenarios through the routes against SQLite. `src/ledger.test-support.ts` seeds a
small EUR ledger and refers to everything by name.
