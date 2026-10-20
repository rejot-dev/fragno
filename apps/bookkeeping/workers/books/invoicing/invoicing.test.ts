import { describe, expect, test } from "vitest";

import { bookkeepingScenario } from "../books.test-support";
import { draftInvoice, issueInvoice } from "./invoices.test-support";

describe("invoicing", () => {
  test("sales invoices are numbered gaplessly when issued and never change afterwards", () =>
    bookkeepingScenario((books) => {
      books.rejects(
        () =>
          books.operation(() => {
            books.sql(
              "INSERT INTO source_document VALUES ('x', 'purchase_invoice', '2026-01-10', 'x')",
            );
            books.sql(
              `INSERT INTO invoice (source_document_id, party_account_id, party_role, kind,
                 sequence_number, supplier_reference, party_name_snapshot,
                 billing_address_snapshot, due_date, currency_code, status)
               VALUES ('x', 'alice-c', 'customer', 'invoice', NULL, NULL, 'n', '{}',
                 '2026-02-10', 'EUR', 'draft')`,
            );
          }),
        "FOREIGN KEY",
      );
      draftInvoice(books, {
        id: "first",
        partyAccount: "alice-c",
        role: "customer",
        lines: [{ account: "revenue", net: 10000, vatCodeVersion: "high-sales-2019", vat: 2100 }],
      });
      draftInvoice(books, { id: "second", partyAccount: "bob-c", role: "customer", lines: [] });
      books.rejects(() => issueInvoice(books, "second", 1), "Issuing requires at least one line");
      books.rejects(() => issueInvoice(books, "first", 2), "Sales invoice numbers are gapless");
      issueInvoice(books, "first", 1);

      books.rejects(
        () =>
          books.sql(
            "UPDATE invoice SET due_date = '2026-03-01' WHERE source_document_id = 'first'",
          ),
        "Issued invoices are immutable",
      );
      books.rejects(
        () => books.sql("DELETE FROM invoice_line WHERE invoice_id = 'first'"),
        "Issued invoice lines are immutable",
      );
      books.rejects(
        () => books.sql("DELETE FROM invoice WHERE source_document_id = 'first'"),
        "Issued invoices cannot be deleted",
      );

      expect(
        books.sql("SELECT source_document_id, status, sequence_number FROM invoice ORDER BY 1"),
      ).toEqual([
        { source_document_id: "first", status: "issued", sequence_number: 1 },
        { source_document_id: "second", status: "draft", sequence_number: null },
      ]);
    }));

  test("purchase invoices keep the supplier's own number, unique per supplier", () =>
    bookkeepingScenario((books) => {
      const purchase = {
        partyAccount: "bob-s",
        role: "supplier",
        lines: [{ account: "costs", net: 2500, vatCodeVersion: "high-purchase-2019", vat: 525 }],
      } as const;

      books.rejects(() => draftInvoice(books, { ...purchase, id: "x" }), "CHECK constraint failed");
      books.rejects(
        () =>
          draftInvoice(books, {
            ...purchase,
            id: "x",
            partyAccount: "alice-c",
            supplierReference: "INV-7",
          }),
        "FOREIGN KEY",
      );
      draftInvoice(books, { ...purchase, id: "p1", supplierReference: "INV-7" });
      books.rejects(
        () => draftInvoice(books, { ...purchase, id: "p2", supplierReference: "INV-7" }),
        "UNIQUE",
      );
      issueInvoice(books, "p1", null);

      expect(books.sql("SELECT supplier_reference, status FROM invoice")).toEqual([
        { supplier_reference: "INV-7", status: "issued" },
      ]);
    }));
});
