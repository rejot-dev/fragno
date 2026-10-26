# Books

One SQLite database, the `Books` Durable Object in `books.ts`, per administration holds its books.
Isolation, backup, export and deletion are per database, so no table carries an administration
column.

`Books` runs the ledger fragment (`@fragno-dev/ledger`) on the object's database and exposes its
operations as RPC methods. The documents fragment in `documents/` runs on the same database adapter
and books documents through the ledger's services, in the same transaction. The ledger's refusals
return as `Outcome` values, because errors crossing Durable Object RPC keep only their message.
Opening the books (`open`) sets the functional currency (`currencies.ts`) and, in the same
transaction, this calendar year's monthly periods (`fiscal-years.ts`) and the default journals and
chart of accounts (`default-books.ts`).

The SQL files below are the reference design the ledger fragment was built from, and the design of
the areas not built yet. `schema.ts` concatenates them in dependency order for their tests; no
Durable Object applies them.

| Directory        | Owns                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger`         | calendar, currencies, accounts, journals, dimensions, parties, source documents, journal entries and lines, settlement allocations and open items |
| `classification` | reporting schemes (e.g. RGS) and account mappings                                                                                                 |
| `invoicing`      | payment terms, sales and purchase invoices (net amounts)                                                                                          |
| `banking`        | bank accounts, their ledger accounts, imported statements, reconciliation                                                                         |
| `budgeting`      | budget scenarios and lines                                                                                                                        |
| `vat`            | VAT codes and dated rates, line facts, VAT on invoices, box mappings, filed returns                                                               |

Each directory holds its SQL files and the tests and test helpers for them.

## Conventions

- The ledger references nothing outside `ledger/`; other directories build on it. VAT also builds on
  invoicing.
- Objects outside the ledger carry their area's prefix (`classification`, `invoice`, `bank`,
  `budget`, `vat`).
- An area extends another area's rules with its own triggers instead of editing theirs. SQLite runs
  every `BEFORE` trigger on an event and any of them can abort it:
  - posting:
    `BEFORE UPDATE OF status ON journal_entry WHEN OLD.status = 'draft' AND NEW.status = 'posted'`
  - issuing: the same on `invoice`
  - sealing dimension sets: `BEFORE INSERT ON dimension_set_value` when the area references the set
  - designating accounts: banking and VAT freeze the ledger accounts they designate
- Areas register their source kinds by inserting into `source_kind`.

The ledger itself knows only `ordinary`, `receivable` and `payable` accounts. An account is a bank
account because `bank_ledger_account` links it, and a VAT account because a `vat_code` posts to it.

Copies of data across tables exist only where the source is immutable and an insert trigger checks
the copy: `settlement_allocation` copies party account and currency from its lines, and
`vat_line_fact` copies the entry's accounting period (checked again when the entry posts).

Files contain only DDL and seed rows. Durable Objects reject `BEGIN`/`COMMIT` and most `PRAGMA`s;
transactions come from `transactionSync`, and foreign keys are always enforced.

## Writing to the SQL design

The ledger fragment moves these rules from the database into its services (see its README). In the
SQL design, each domain operation runs in one transaction. The Durable Object is the single writer,
so "next number = MAX + 1" for gapless entry and invoice numbers cannot race. Posting inserts the
entry as a draft, writes its lines and VAT facts, then sets it to `posted`; the posting triggers
check it. A committed draft entry is an application bug.

The database guards integrity: immutability, balance, numbering, control accounts, allocation
limits, period state. The application owns policy: VAT calculation and rounding, exchange-rate
choice, which accounts to post to, and checks that need data written after the guarded row
(statement totals, reconciliation totals, invoice and entry agreement).

## Tests

`pnpm test` runs scenarios against in-memory `node:sqlite` databases with the full schema
(`books.test-support.ts`). They exercise the same SQL as production but not Durable Object specifics
such as `transactionSync`.
