import type { Books } from "../books.test-support";

type InvoiceDraft = {
  id: string;
  partyAccount: string;
  role: "customer" | "supplier";
  supplierReference?: string;
  lines: readonly { account: string; net: number; vatCodeVersion: string; vat: number }[];
};

export function draftInvoice(books: Books, invoice: InvoiceDraft): void {
  books.operation(() => {
    books.sql(
      "INSERT INTO source_document VALUES (?, ?, '2026-01-10', 'scenario')",
      invoice.id,
      invoice.role === "customer" ? "sales_invoice" : "purchase_invoice",
    );
    books.sql(
      `INSERT INTO invoice (source_document_id, party_account_id, party_role, kind,
         sequence_number, supplier_reference, party_name_snapshot, billing_address_snapshot,
         due_date, currency_code, status)
       VALUES (?, ?, ?, 'invoice', NULL, ?, 'Snapshot BV',
         '{"street_line_1":"Main 1","city":"Utrecht","country_code":"NL"}',
         '2026-02-10', 'EUR', 'draft')`,
      invoice.id,
      invoice.partyAccount,
      invoice.role,
      invoice.supplierReference ?? null,
    );
    books.sql("INSERT INTO vat_invoice VALUES (?, '2026-01-10')", invoice.id);
    invoice.lines.forEach((line, index) => {
      books.sql(
        "INSERT INTO invoice_line VALUES (?, ?, 'work', 1000000, ?, ?, 'none')",
        invoice.id,
        index + 1,
        line.net,
        line.account,
      );
      books.sql(
        "INSERT INTO vat_invoice_line VALUES (?, ?, ?, ?)",
        invoice.id,
        index + 1,
        line.vatCodeVersion,
        line.vat,
      );
    });
  });
}

export function issueInvoice(books: Books, id: string, sequenceNumber: number | null): void {
  books.operation(() => {
    books.sql(
      "UPDATE invoice SET status = 'issued', sequence_number = ? WHERE source_document_id = ?",
      sequenceNumber,
      id,
    );
  });
}
