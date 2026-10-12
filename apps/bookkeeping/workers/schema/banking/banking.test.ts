import { describe, expect, test } from "vitest";

import { bookkeepingScenario, credit, debit } from "../books.test-support";

describe("banking", () => {
  test("statement transactions reconcile only against postings on their bank ledger account", () =>
    bookkeepingScenario((books) => {
      books.sql(
        `INSERT INTO bank_account VALUES ('own', NULL, 'NL01BANK0123456789', 'EUR'),
           ('alice-iban', 'alice', 'NL02BANK0123456789', 'EUR')`,
      );
      books.rejects(
        () => books.sql("INSERT INTO bank_ledger_account VALUES ('alice-iban', 'bank')"),
        "Only own bank accounts are booked in the ledger",
      );
      books.rejects(
        () => books.sql("INSERT INTO bank_ledger_account VALUES ('own', 'usd-bank')"),
        "Bank ledger accounts are ordinary asset accounts in the bank currency",
      );
      books.sql("INSERT INTO bank_ledger_account VALUES ('own', 'bank')");
      books.rejects(
        () => books.sql("UPDATE ledger_account SET currency_code = NULL WHERE id = 'bank'"),
        "Bank ledger accounts keep their type, role and currency",
      );

      books.operation(() => {
        books.sql(
          "INSERT INTO bank_statement VALUES ('st1', 'own', '2026-001', '2026-01-01', '2026-01-31', 0, 12100)",
        );
        books.sql(
          "INSERT INTO source_document VALUES ('tx1', 'bank_transaction', '2026-01-12', 'Alice')",
        );
        books.sql(
          `INSERT INTO bank_transaction (source_document_id, statement_id, external_reference,
             booking_date, value_date, amount_minor, counterparty_description)
           VALUES ('tx1', 'st1', 'ref-1', '2026-01-12', '2026-01-12', 12100, 'Alice BV')`,
        );
      });
      books.rejects(
        () => books.sql("UPDATE bank_transaction SET amount_minor = 1"),
        "Imported bank transactions are immutable",
      );
      books.post({
        id: "receipt",
        journal: "bank",
        number: 1,
        lines: [debit("bank", 12100), credit("ar", 12100, { party: "alice-c" })],
      });
      books.rejects(
        () => books.sql("INSERT INTO bank_reconciliation VALUES ('tx1', 'receipt', 2, 12100)"),
        "Reconcile posted lines on the ledger account of the statement bank account",
      );
      books.sql("INSERT INTO bank_reconciliation VALUES ('tx1', 'receipt', 1, 12100)");

      expect(books.sql("SELECT entry_id, line_number FROM bank_reconciliation")).toEqual([
        { entry_id: "receipt", line_number: 1 },
      ]);
    }));
});
