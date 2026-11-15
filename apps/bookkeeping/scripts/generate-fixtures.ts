import { writeFileSync } from "node:fs";

import { renderInvoicePdf } from "../scenario/fixtures/invoice";
import { marchStatement, renderCamt053 } from "../scenario/fixtures/statement";

// Writes the scenario fixtures that are rendered from code, after changing what they render.
const invoicePath = new URL("../scenario/fixtures/invoice.pdf", import.meta.url);
writeFileSync(invoicePath, renderInvoicePdf());
console.log(`Wrote ${invoicePath.pathname}`);

// The statement pays the invoice, dated in the year the invoice is.
const statementPath = new URL("../scenario/fixtures/statement.xml", import.meta.url);
writeFileSync(statementPath, renderCamt053([marchStatement(2026)]));
console.log(`Wrote ${statementPath.pathname}`);
