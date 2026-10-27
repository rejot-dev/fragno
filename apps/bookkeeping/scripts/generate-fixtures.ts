import { writeFileSync } from "node:fs";

import { renderInvoicePdf } from "../scenario/fixtures/invoice";

// Writes the scenario fixtures that are rendered from code, after changing what they render.
const invoicePath = new URL("../scenario/fixtures/invoice.pdf", import.meta.url);
writeFileSync(invoicePath, renderInvoicePdf());
console.log(`Wrote ${invoicePath.pathname}`);
