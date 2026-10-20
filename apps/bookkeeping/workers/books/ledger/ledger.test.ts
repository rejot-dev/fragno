import { assert, describe, expect, test } from "vitest";

import { bookkeepingScenario, credit, debit, timestamp, type Books } from "../books.test-support";

const sale = (party = "alice-c", amount = 12100) => [
  debit("ar", amount, { party }),
  credit("revenue", amount),
];

function postSale(books: Books, id: string, number: number, party = "alice-c") {
  books.post({ id, journal: "sales", number, lines: sale(party) });
}

describe("ledger", () => {
  test("posting numbers entries gaplessly per journal", () =>
    bookkeepingScenario((books) => {
      postSale(books, "e1", 1);
      books.rejects(() => postSale(books, "e2", 3), "Entry numbers are gapless per journal");
      postSale(books, "e2", 2);
      books.post({
        id: "m1",
        journal: "memo",
        number: 1,
        lines: [debit("costs", 500, { dimensions: "sales" }), credit("bank", 500)],
      });
      books.rejects(
        () =>
          books.sql(
            `INSERT INTO journal_entry VALUES
               ('x', 'sales', ?, 3, '2026-01-10', 'p1', 'skip the draft', 'posted', ?, 'u', NULL)`,
            books.source("manual_journal"),
            timestamp,
          ),
        "Create entries as drafts before posting",
      );

      expect(
        books.sql(
          "SELECT journal_id, entry_number FROM journal_entry ORDER BY journal_id, entry_number",
        ),
      ).toEqual([
        { journal_id: "memo", entry_number: 1 },
        { journal_id: "sales", entry_number: 1 },
        { journal_id: "sales", entry_number: 2 },
      ]);
    }));

  test("control-account lines carry exactly the party that owns the account", () =>
    bookkeepingScenario((books) => {
      books.rejects(
        () =>
          books.post({
            id: "x",
            journal: "sales",
            number: 1,
            lines: [debit("ap", 100, { party: "alice-c" }), credit("revenue", 100)],
          }),
        "FOREIGN KEY",
      );
      books.rejects(
        () =>
          books.post({
            id: "x",
            journal: "sales",
            number: 1,
            lines: [debit("ar", 100), credit("revenue", 100)],
          }),
        "Control-account lines require a party",
      );
      books.rejects(
        () =>
          books.sql(
            `INSERT INTO party_account (id, party_id, role, code, control_account_id)
             VALUES ('alice-s', 'alice', 'supplier', 'S9', 'ar')`,
          ),
        "FOREIGN KEY",
      );
      postSale(books, "e1", 1);

      expect(books.sql("SELECT entry_id, party_account_id, due_date FROM open_item")).toEqual([
        { entry_id: "e1", party_account_id: "alice-c", due_date: "2026-02-10" },
      ]);
    }));

  test("posting enforces balance, account currency and dimension rules", () =>
    bookkeepingScenario((books) => {
      books.rejects(
        () =>
          books.post({
            id: "x",
            journal: "sales",
            number: 1,
            lines: [debit("ar", 100, { party: "alice-c" }), credit("revenue", 90)],
          }),
        "Functional currency debits and credits must balance",
      );
      books.rejects(
        () =>
          books.post({
            id: "x",
            journal: "memo",
            number: 1,
            lines: [debit("costs", 500, { dimensions: "sales" }), credit("usd-bank", 500)],
          }),
        "Line currency must match the account currency",
      );
      books.rejects(
        () =>
          books.post({
            id: "x",
            journal: "memo",
            number: 1,
            lines: [debit("costs", 500), credit("bank", 500)],
          }),
        "Lines must satisfy their account dimension rules",
      );
      books.post({
        id: "m1",
        journal: "memo",
        number: 1,
        lines: [
          debit("costs", 500, { dimensions: "sales" }),
          credit("usd-bank", 500, { currency: "USD" }),
        ],
      });

      expect(books.sql("SELECT entry_id FROM posted_ledger GROUP BY entry_id")).toEqual([
        { entry_id: "m1" },
      ]);
    }));

  test("posted entries are corrected only by an exact reversal", () =>
    bookkeepingScenario((books) => {
      postSale(books, "e1", 1);
      books.rejects(
        () =>
          books.sql(
            "UPDATE journal_entry_line SET transaction_amount_minor = 1 WHERE entry_id = 'e1'",
          ),
        "Posted lines are immutable",
      );
      books.rejects(
        () => books.sql("DELETE FROM journal_entry WHERE id = 'e1'"),
        "Posted entries cannot be deleted",
      );
      books.rejects(
        () =>
          books.post({
            id: "r1",
            journal: "sales",
            number: 2,
            reverses: "e1",
            lines: [credit("ar", 12000, { party: "alice-c" }), debit("revenue", 12000)],
          }),
        "A reversal must mirror the original lines with sides swapped",
      );
      books.post({
        id: "r1",
        journal: "sales",
        number: 2,
        reverses: "e1",
        lines: [debit("revenue", 12100), credit("ar", 12100, { party: "alice-c" })],
      });
      books.rejects(
        () =>
          books.post({
            id: "r2",
            journal: "sales",
            number: 3,
            reverses: "e1",
            lines: [debit("revenue", 12100), credit("ar", 12100, { party: "alice-c" })],
          }),
        "UNIQUE",
      );

      expect(
        books.sql("SELECT SUM(signed_functional_amount_minor) AS balance FROM posted_ledger"),
      ).toEqual([{ balance: 0 }]);
    }));

  test("settlement allocates open items within their outstanding amounts", () =>
    bookkeepingScenario((books) => {
      postSale(books, "invoice", 1);
      postSale(books, "bob-invoice", 2, "bob-c");
      books.post({
        id: "receipt",
        journal: "bank",
        number: 1,
        lines: [debit("bank", 12100), credit("ar", 12100, { party: "alice-c" })],
      });
      const settle = { party: "alice-c", debit: ["invoice", 1], credit: ["receipt", 2] } as const;

      books.allocate({ id: "a1", ...settle, amount: 10000 });
      books.rejects(
        () => books.allocate({ id: "a2", ...settle, amount: 2101 }),
        "Allocation exceeds the outstanding amount",
      );
      books.allocate({ id: "a2", ...settle, amount: 2100 });
      assert.equal(books.outstanding("invoice", 1), 0);

      books.rejects(
        () => books.sql("DELETE FROM settlement_allocation WHERE id = 'a1'"),
        "Allocations are append-only",
      );
      books.allocate({ id: "a1-undo", ...settle, amount: 10000, reverses: "a1" });
      assert.equal(books.outstanding("invoice", 1), 10000);
      books.rejects(
        () => books.allocate({ id: "x", ...settle, amount: 10000, reverses: "a1-undo" }),
        "A reversing allocation must mirror an active allocation",
      );
      books.rejects(
        () => books.allocate({ ...settle, id: "x", debit: ["bob-invoice", 1], amount: 100 }),
        "Allocated items must share the allocation party account and currency",
      );
      books.rejects(
        () => books.allocate({ ...settle, id: "x", credit: ["invoice", 2], amount: 100 }),
        "Allocations settle a posted debit open item against a posted credit one",
      );

      assert.equal(books.outstanding("receipt", 2), 10000);
    }));

  test("periods only move forward to locked and bound the entries posted in them", () =>
    bookkeepingScenario((books) => {
      books.rejects(
        () =>
          books.sql(
            "INSERT INTO accounting_period VALUES ('px', 'fy26', 3, '2026-02-15', '2026-03-31', 'open')",
          ),
        "Periods must not overlap",
      );
      books.rejects(
        () =>
          books.sql(
            "INSERT INTO accounting_period VALUES ('px', 'fy26', 3, '2026-12-01', '2027-01-31', 'open')",
          ),
        "Periods must lie within their fiscal year",
      );
      books.rejects(
        () =>
          books.post({
            id: "x",
            journal: "sales",
            number: 1,
            date: "2026-02-10",
            period: "p1",
            lines: sale(),
          }),
        "Posting requires an open period containing the posting date",
      );
      books.sql("UPDATE accounting_period SET status = 'closed' WHERE id = 'p2'");
      books.rejects(
        () =>
          books.post({
            id: "x",
            journal: "sales",
            number: 1,
            date: "2026-02-10",
            period: "p2",
            lines: sale(),
          }),
        "Posting requires an open period containing the posting date",
      );
      books.sql("UPDATE accounting_period SET status = 'locked' WHERE id = 'p2'");
      books.rejects(
        () => books.sql("UPDATE accounting_period SET status = 'open' WHERE id = 'p2'"),
        "Periods move open <-> closed -> locked",
      );

      expect(books.sql("SELECT id, status FROM accounting_period ORDER BY id")).toEqual([
        { id: "p1", status: "open" },
        { id: "p2", status: "locked" },
      ]);
    }));

  test("master data that posted history depends on is frozen", () =>
    bookkeepingScenario((books) => {
      books.sql(
        "UPDATE ledger_account SET type = 'expense', normal_side = 'debit' WHERE id = 'revenue'",
      );
      books.sql(
        "UPDATE ledger_account SET type = 'revenue', normal_side = 'credit' WHERE id = 'revenue'",
      );
      postSale(books, "e1", 1);

      books.rejects(
        () => books.sql("UPDATE ledger_account SET type = 'expense' WHERE id = 'revenue'"),
        "Account semantics are fixed once postings exist",
      );
      books.sql("UPDATE ledger_account SET name = 'Turnover' WHERE id = 'revenue'");
      books.rejects(
        () => books.sql("UPDATE administration SET functional_currency = 'USD'"),
        "Functional currency is fixed once entries are posted",
      );
      books.rejects(
        () => books.sql("INSERT INTO dimension_set_value VALUES ('none', 'cc', 'cc-sales')"),
        "Dimension sets are sealed once referenced",
      );
      books.sql("INSERT INTO dimension_set_value VALUES ('unused', 'cc', 'cc-support')");
      books.rejects(
        () =>
          books.sql("UPDATE dimension_value SET parent_id = 'cc-support' WHERE id = 'cc-sales'"),
        "Dimension hierarchies must not contain cycles",
      );

      expect(books.sql("SELECT name, type FROM ledger_account WHERE id = 'revenue'")).toEqual([
        { name: "Turnover", type: "revenue" },
      ]);
    }));
});
