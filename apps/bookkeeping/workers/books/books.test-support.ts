import { expect } from "vitest";

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { bookkeepingSchema } from "./schema";

type SqlValue = string | number | null;

type Line = {
  account: string;
  side: "debit" | "credit";
  amount: number;
  party?: string;
  dimensions?: string;
  currency?: string;
};

type Posting = {
  id: string;
  journal: string;
  number: number;
  lines: readonly Line[];
  date?: string;
  period?: string;
  reverses?: string;
  sourceKind?: string;
  /** Writes related rows (e.g. VAT facts) while the entry is still a draft. */
  attach?: (books: Books) => void;
};

export const timestamp = "2026-01-15T10:00:00.000Z";

export function debit(account: string, amount: number, details: Partial<Line> = {}): Line {
  return { account, side: "debit", amount, ...details };
}

export function credit(account: string, amount: number, details: Partial<Line> = {}): Line {
  return { account, side: "credit", amount, ...details };
}

/**
 * Runs a scenario against a fresh in-memory SQLite database with the full schema, seeded with
 * a small EUR administration:
 * - periods p1 (January 2026) and p2 (February 2026), both open
 * - journals sales, purchase, bank, memo
 * - accounts ar, ap, revenue, costs (requires dimension cc), bank (EUR), usd-bank (USD)
 * - customers alice-c and bob-c, supplier bob-s
 * - dimension sets none (empty), sales (cc=sales) and unused (cc=support, no values yet)
 * - VAT accounts vat-payable, vat-recoverable and vat-due, with code versions
 *   high-sales-2019 and high-purchase-2019 (21%) and zero-sales-2019 (0%)
 */
export function bookkeepingScenario(steps: (books: Books) => void): void {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  try {
    database.exec(bookkeepingSchema);
    const books = new Books(database);
    books.operation(() => {
      seedAdministration(books);
    });
    steps(books);
  } finally {
    database.close();
  }
}

export class Books {
  readonly #database: DatabaseSync;
  #documents = 0;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** Runs exactly one statement and returns its rows. */
  sql(query: string, ...bindings: SQLInputValue[]): Record<string, SqlValue>[] {
    // Spread into plain objects: node:sqlite rows have a null prototype.
    return this.#database
      .prepare(query)
      .all(...bindings)
      .map((row) => ({ ...row }) as Record<string, SqlValue>);
  }

  /** Runs setup SQL with several statements; `sql` would silently run only the first. */
  script(sql: string): void {
    this.#database.exec(sql);
  }

  /**
   * One domain operation: all its writes commit together or not at all, as with the Durable
   * Object's transactionSync. Savepoints let operations nest.
   */
  operation(step: () => void): void {
    this.#database.exec("SAVEPOINT operation");
    try {
      step();
    } catch (error) {
      this.#database.exec("ROLLBACK TO operation; RELEASE operation");
      throw error;
    }
    this.#database.exec("RELEASE operation");
  }

  rejects(step: () => void, message: string): void {
    expect(() => {
      this.operation(step);
    }).toThrow(message);
  }

  source(kind: string, date = "2026-01-10"): string {
    this.#documents += 1;
    const id = `doc-${this.#documents}`;
    this.sql("INSERT INTO source_document VALUES (?, ?, ?, 'scenario')", id, kind, date);
    return id;
  }

  post(posting: Posting): void {
    this.operation(() => {
      const date = posting.date ?? "2026-01-10";
      this.sql(
        `INSERT INTO journal_entry (id, journal_id, source_document_id, posting_date,
           accounting_period_id, description, status, reverses_entry_id)
         VALUES (?, ?, ?, ?, ?, 'scenario', 'draft', ?)`,
        posting.id,
        posting.journal,
        this.source(posting.sourceKind ?? "manual_journal", date),
        date,
        posting.period ?? "p1",
        posting.reverses ?? null,
      );
      posting.lines.forEach((line, index) => {
        this.sql(
          "INSERT INTO journal_entry_line VALUES (?, ?, ?, ?, ?, ?, ?, 'scenario', ?, ?, ?)",
          posting.id,
          index + 1,
          line.account,
          line.side,
          line.currency ?? "EUR",
          line.amount,
          line.amount,
          line.dimensions ?? "none",
          line.party ?? null,
          line.party === undefined ? null : "2026-02-10",
        );
      });
      posting.attach?.(this);
      this.sql(
        `UPDATE journal_entry SET status = 'posted', entry_number = ?, posted_at = ?,
           posted_by = 'scenario-user' WHERE id = ?`,
        posting.number,
        timestamp,
        posting.id,
      );
    });
  }

  allocate(allocation: {
    id: string;
    party: string;
    debit: readonly [entry: string, line: number];
    credit: readonly [entry: string, line: number];
    amount: number;
    reverses?: string;
  }): void {
    this.operation(() => {
      this.sql(
        `INSERT INTO settlement_allocation VALUES (?, ?, 'EUR', ?, ?, ?, ?, ?, ?, 'scenario-user', ?, NULL)`,
        allocation.id,
        allocation.party,
        ...allocation.debit,
        ...allocation.credit,
        allocation.amount,
        timestamp,
        allocation.reverses ?? null,
      );
    });
  }

  outstanding(entry: string, line: number): SqlValue {
    const [item] = this.sql(
      "SELECT outstanding_minor FROM open_item WHERE entry_id = ? AND line_number = ?",
      entry,
      line,
    );
    return item.outstanding_minor;
  }
}

function seedAdministration(books: Books): void {
  for (const statement of [
    "INSERT INTO currency VALUES ('EUR', 2), ('USD', 2)",
    "INSERT INTO administration VALUES (1, 'Acme BV', 'EUR')",
    "INSERT INTO fiscal_year VALUES ('fy26', '2026', '2026-01-01', '2026-12-31')",
    `INSERT INTO accounting_period VALUES
       ('p1', 'fy26', 1, '2026-01-01', '2026-01-31', 'open'),
       ('p2', 'fy26', 2, '2026-02-01', '2026-02-28', 'open')`,
    `INSERT INTO journal VALUES ('sales', 'VK', 'Sales'), ('purchase', 'IK', 'Purchases'),
       ('bank', 'BNK', 'Bank'), ('memo', 'MEM', 'Memorial')`,
    `INSERT INTO ledger_account VALUES
       ('ar', '1300', 'Debtors', 'asset', 'debit', 'receivable', NULL, 1),
       ('ap', '1600', 'Creditors', 'liability', 'credit', 'payable', NULL, 1),
       ('revenue', '8000', 'Revenue', 'revenue', 'credit', 'ordinary', NULL, 1),
       ('costs', '4000', 'Costs', 'expense', 'debit', 'ordinary', NULL, 1),
       ('bank', '1100', 'Bank', 'asset', 'debit', 'ordinary', 'EUR', 1),
       ('usd-bank', '1110', 'Bank USD', 'asset', 'debit', 'ordinary', 'USD', 1)`,
    "INSERT INTO party VALUES ('alice', 'Alice BV'), ('bob', 'Bob BV')",
    `INSERT INTO party_account (id, party_id, role, code, control_account_id) VALUES
       ('alice-c', 'alice', 'customer', 'C1', 'ar'),
       ('bob-c', 'bob', 'customer', 'C2', 'ar'),
       ('bob-s', 'bob', 'supplier', 'S1', 'ap')`,
    "INSERT INTO dimension VALUES ('cc', 'CC', 'Cost centre')",
    `INSERT INTO dimension_value VALUES
       ('cc-sales', 'cc', NULL, 'S', 'Sales'), ('cc-support', 'cc', 'cc-sales', 'SU', 'Support')`,
    "INSERT INTO dimension_set VALUES ('none', ''), ('sales', 'cc=cc-sales'), ('unused', 'cc=cc-support')",
    "INSERT INTO dimension_set_value VALUES ('sales', 'cc', 'cc-sales')",
    "INSERT INTO ledger_account_dimension_rule VALUES ('costs', 'cc', 'required')",
    `INSERT INTO ledger_account VALUES
       ('vat-payable', '1500', 'VAT payable', 'liability', 'credit', 'ordinary', NULL, 1),
       ('vat-recoverable', '1510', 'VAT recoverable', 'asset', 'debit', 'ordinary', NULL, 1),
       ('vat-due', '1520', 'VAT due', 'liability', 'credit', 'ordinary', NULL, 1)`,
    `INSERT INTO vat_code VALUES
       ('high-sales', 'NL-H-S', 'NL', 'sales', 'standard', 'vat-payable', NULL),
       ('high-purchase', 'NL-H-P', 'NL', 'purchase', 'standard', NULL, 'vat-recoverable'),
       ('zero-sales', 'NL-0-S', 'NL', 'sales', 'zero', NULL, NULL)`,
    `INSERT INTO vat_code_version VALUES
       ('high-sales-2019', 'high-sales', '2019-01-01', 210000, 0),
       ('high-purchase-2019', 'high-purchase', '2019-01-01', 210000, 1000000),
       ('zero-sales-2019', 'zero-sales', '2019-01-01', 0, 0)`,
  ]) {
    books.sql(statement);
  }
}
