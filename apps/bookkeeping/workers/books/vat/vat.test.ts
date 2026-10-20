import { describe, expect, test } from "vitest";

import { bookkeepingScenario, credit, debit, timestamp, type Books } from "../books.test-support";
import { draftInvoice, issueInvoice } from "../invoicing/invoices.test-support";

const taxedSale = [
  debit("ar", 12100, { party: "alice-c" }),
  credit("revenue", 10000),
  credit("vat-payable", 2100),
];

function saleFacts(entry: string, sign: 1 | -1) {
  return (books: Books) =>
    books.sql(
      "INSERT INTO vat_line_fact VALUES (?, 2, 'high-sales-2019', '2026-01-10', 'p1', ?, ?)",
      entry,
      10000 * sign,
      2100 * sign,
    );
}

describe("vat", () => {
  test("VAT codes post to accounts that match their policy, and that policy never changes", () =>
    bookkeepingScenario((books) => {
      books.rejects(
        () =>
          books.sql(
            "INSERT INTO vat_code VALUES ('x', 'X', 'NL', 'sales', 'standard', NULL, NULL)",
          ),
        "CHECK constraint failed",
      );
      books.rejects(
        () =>
          books.sql(
            "INSERT INTO vat_code VALUES ('x', 'X', 'NL', 'sales', 'standard', 'vat-recoverable', NULL)",
          ),
        "VAT payable accounts are ordinary liability accounts",
      );
      books.rejects(
        () =>
          books.sql(
            "INSERT INTO vat_code VALUES ('x', 'X', 'NL', 'purchase', 'reverse_charge', NULL, 'vat-recoverable')",
          ),
        "CHECK constraint failed",
      );
      books.sql(
        `INSERT INTO vat_code VALUES
           ('rc-purchase', 'NL-RC-P', 'NL', 'purchase', 'reverse_charge', 'vat-payable', 'vat-recoverable')`,
      );
      books.rejects(
        () => books.sql("UPDATE vat_code SET treatment = 'zero' WHERE id = 'high-sales'"),
        "VAT code policy is immutable",
      );
      books.rejects(
        () => books.sql("UPDATE vat_code_version SET rate_ppm = 90000"),
        "VAT code versions are immutable",
      );
      books.rejects(
        () => books.sql("UPDATE ledger_account SET type = 'asset' WHERE id = 'vat-payable'"),
        "VAT accounts keep their type and role",
      );
      books.sql("UPDATE vat_code SET code = 'NL-HOOG-V' WHERE id = 'high-sales'");

      expect(books.sql("SELECT code FROM vat_code WHERE id = 'high-sales'")).toEqual([
        { code: "NL-HOOG-V" },
      ]);
    }));

  test("invoices issue only with a VAT code of the matching direction on every line", () =>
    bookkeepingScenario((books) => {
      draftInvoice(books, {
        id: "inv",
        partyAccount: "alice-c",
        role: "customer",
        lines: [
          { account: "revenue", net: 10000, vatCodeVersion: "high-sales-2019", vat: 2100 },
          { account: "revenue", net: 3000, vatCodeVersion: "zero-sales-2019", vat: 0 },
        ],
      });
      books.sql("DELETE FROM vat_invoice_line WHERE line_number = 2");
      books.rejects(
        () => issueInvoice(books, "inv", 1),
        "Issuing requires a VAT code on every line",
      );
      books.rejects(
        () =>
          books.sql("INSERT INTO vat_invoice_line VALUES ('inv', 2, 'high-purchase-2019', 630)"),
        "Sales invoices use sales VAT codes, purchase invoices purchase codes",
      );
      books.sql("INSERT INTO vat_invoice_line VALUES ('inv', 2, 'zero-sales-2019', 0)");
      issueInvoice(books, "inv", 1);
      books.rejects(
        () => books.sql("UPDATE vat_invoice_line SET vat_amount_minor = 0"),
        "Issued invoice VAT is immutable",
      );

      expect(
        books.sql(
          `SELECT SUM(l.net_amount_minor + v.vat_amount_minor) AS total
           FROM invoice_line l JOIN vat_invoice_line v
             ON v.invoice_id = l.invoice_id AND v.line_number = l.number`,
        ),
      ).toEqual([{ total: 15100 }]);
    }));

  test("entries on VAT accounts need VAT facts, and reversals negate them", () =>
    bookkeepingScenario((books) => {
      books.rejects(
        () => books.post({ id: "x", journal: "sales", number: 1, lines: taxedSale }),
        "Entries posting to VAT accounts need VAT facts",
      );
      books.rejects(
        () =>
          books.post({
            id: "x",
            journal: "sales",
            number: 1,
            lines: taxedSale,
            attach: (b) =>
              b.sql(
                "INSERT INTO vat_line_fact VALUES ('x', 2, 'high-sales-2019', '2026-01-10', 'p2', 10000, 2100)",
              ),
          }),
        "VAT facts must carry the entry accounting period",
      );
      books.post({
        id: "sale",
        journal: "sales",
        number: 1,
        lines: taxedSale,
        attach: saleFacts("sale", 1),
      });
      books.rejects(() => books.sql("DELETE FROM vat_line_fact"), "Posted VAT facts are immutable");

      const reversal = {
        journal: "sales",
        number: 2,
        reverses: "sale",
        lines: [
          credit("ar", 12100, { party: "alice-c" }),
          debit("revenue", 10000),
          debit("vat-payable", 2100),
        ],
      };
      books.rejects(
        () => books.post({ ...reversal, id: "undo", attach: saleFacts("undo", 1) }),
        "A reversal must negate the original VAT facts",
      );
      books.post({ ...reversal, id: "undo", attach: saleFacts("undo", -1) });

      expect(
        books.sql(
          "SELECT SUM(base_functional_minor) AS base, SUM(vat_functional_minor) AS vat FROM vat_line_fact",
        ),
      ).toEqual([{ base: 0, vat: 0 }]);
    }));

  test("filing a return clears VAT and locks the closed periods it covers", () =>
    bookkeepingScenario((books) => {
      books.post({
        id: "sale",
        journal: "sales",
        number: 1,
        lines: taxedSale,
        attach: saleFacts("sale", 1),
      });
      books.post({
        id: "clearing",
        journal: "memo",
        number: 1,
        date: "2026-02-10",
        period: "p2",
        sourceKind: "vat_settlement",
        lines: [debit("vat-payable", 2100), credit("vat-due", 2100)],
      });
      books.post({
        id: "not-a-clearing",
        journal: "memo",
        number: 2,
        date: "2026-02-10",
        period: "p2",
        lines: [debit("bank", 1), credit("vat-due", 1)],
      });
      const fileReturn = (settlementEntry: string) => () =>
        books.sql(
          "INSERT INTO vat_return VALUES ('q1', ?, 'scenario-user', ?)",
          timestamp,
          settlementEntry,
        );

      books.rejects(
        fileReturn("not-a-clearing"),
        "VAT settlement entries must be posted VAT settlements",
      );
      books.rejects(
        () =>
          books.operation(() => {
            fileReturn("clearing")();
            books.sql("INSERT INTO vat_return_period VALUES ('p1', 'q1')");
          }),
        "VAT returns cover closed periods",
      );
      books.sql("UPDATE accounting_period SET status = 'closed' WHERE id = 'p1'");
      books.operation(() => {
        fileReturn("clearing")();
        books.sql("INSERT INTO vat_return_period VALUES ('p1', 'q1')");
        books.sql("INSERT INTO vat_return_box VALUES ('q1', '1a', 2100)");
      });
      books.rejects(
        () => books.sql("UPDATE accounting_period SET status = 'open' WHERE id = 'p1'"),
        "Periods move open <-> closed -> locked",
      );
      books.rejects(
        () => books.sql("DELETE FROM vat_return_box"),
        "Filed VAT returns are immutable",
      );

      expect(books.sql("SELECT status FROM accounting_period WHERE id = 'p1'")).toEqual([
        { status: "locked" },
      ]);
    }));
});
