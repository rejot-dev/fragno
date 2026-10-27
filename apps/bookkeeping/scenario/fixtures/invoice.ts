/**
 * A purchase invoice to Analytical Engines, the client scenarios open books for, rendered as the
 * PDF `invoice.pdf` beside this file: `pnpm fixtures:generate` writes it again after a change.
 * Amounts are in cents, so the totals below are what the PDF prints.
 */

type InvoiceLine = {
  description: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  vatRate: 21 | 9;
};

const LINES: InvoiceLine[] = [
  {
    description: "Brass gear wheel, 40 teeth",
    quantity: 12,
    unit: "pcs",
    unitPriceCents: 1850,
    vatRate: 21,
  },
  {
    description: "Precision axle, hardened steel",
    quantity: 4,
    unit: "pcs",
    unitPriceCents: 4275,
    vatRate: 21,
  },
  {
    description: "Assembly and calibration",
    quantity: 3.5,
    unit: "hrs",
    unitPriceCents: 6500,
    vatRate: 21,
  },
  {
    description: "Technical manual, printed",
    quantity: 1,
    unit: "pcs",
    unitPriceCents: 2400,
    vatRate: 9,
  },
];

const lines = LINES.map((line) => ({
  ...line,
  netCents: Math.round(line.quantity * line.unitPriceCents),
}));
const vat = ([21, 9] as const).map((rate) => {
  const netCents = lines
    .filter((line) => line.vatRate === rate)
    .reduce((sum, line) => sum + line.netCents, 0);
  return { rate, netCents, vatCents: Math.round((netCents * rate) / 100) };
});
const netCents = lines.reduce((sum, line) => sum + line.netCents, 0);

/** What the invoice says, for tests to compare an extraction with. */
export const INVOICE = {
  supplier: {
    name: "Babbage Instruments B.V.",
    address: ["Keizersgracht 123", "1015 CJ Amsterdam", "The Netherlands"],
    vatNumber: "NL861234567B01",
    chamberOfCommerce: "71234567",
    iban: "NL91 ABNA 0417 1643 00",
    email: "billing@babbage-instruments.example",
  },
  customer: {
    name: "Analytical Engines",
    attention: "Ada Lovelace",
    address: ["Herengracht 456", "1017 CA Amsterdam", "The Netherlands"],
  },
  number: "INV-2026-0042",
  invoiceDate: "2026-03-02",
  dueDate: "2026-04-01",
  currency: "EUR",
  lines,
  vat,
  netCents,
  totalCents: netCents + vat.reduce((sum, rate) => sum + rate.vatCents, 0),
};

/** Widths of the printable ASCII characters, 32 to 126, in thousandths of the font size. */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const EURO_WIDTH = 556;

type Font = "regular" | "bold";

function textWidth(text: string, font: Font, size: number): number {
  const widths = font === "bold" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let width = 0;
  for (const character of text) {
    width += character === "€" ? EURO_WIDTH : (widths[character.charCodeAt(0) - 32] ?? 556);
  }
  return (width * size) / 1000;
}

/** A PDF string in WinAnsiEncoding, where the euro sign is byte 0x80. */
function pdfString(text: string): string {
  return `(${text.replace(/[\\()]/gu, (character) => `\\${character}`).replace(/€/gu, "\\200")})`;
}

function money(cents: number): string {
  const [whole, fraction] = (cents / 100).toFixed(2).split(".");
  return `€ ${whole.replace(/\B(?=(\d{3})+$)/gu, ",")}.${fraction}`;
}

function quantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function longDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August"];
  return `${day} ${[...months, "September", "October", "November", "December"][month - 1]} ${year}`;
}

/** The page's drawing operators, in PDF points from the bottom left of an A4 page. */
class Page {
  readonly width = 595;
  readonly height = 842;
  readonly #operators: string[] = [];

  text(
    x: number,
    y: number,
    text: string,
    options: { font?: Font; size?: number; gray?: number } = {},
  ) {
    const { font = "regular", size = 9, gray = 0.1 } = options;
    this.#operators.push(
      `BT /${font === "bold" ? "F2" : "F1"} ${size} Tf ${gray} g ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(text)} Tj ET`,
    );
  }

  /** Text ending at `x`, as amounts line up. */
  textRight(
    x: number,
    y: number,
    text: string,
    options: { font?: Font; size?: number; gray?: number } = {},
  ) {
    this.text(x - textWidth(text, options.font ?? "regular", options.size ?? 9), y, text, options);
  }

  rect(x: number, y: number, width: number, height: number, rgb: [number, number, number]) {
    this.#operators.push(`${rgb.join(" ")} rg ${x} ${y} ${width} ${height} re f`);
  }

  line(x1: number, y1: number, x2: number, y2: number, gray = 0.8, lineWidth = 0.5) {
    this.#operators.push(`${gray} G ${lineWidth} w ${x1} ${y1} m ${x2} ${y2} l S`);
  }

  get content(): string {
    return this.#operators.join("\n");
  }
}

const ACCENT: [number, number, number] = [0.13, 0.29, 0.43];

function drawInvoice(page: Page) {
  const left = 50;
  const right = page.width - 50;
  const { supplier, customer } = INVOICE;

  page.rect(0, page.height - 8, page.width, 8, ACCENT);
  page.text(left, 780, supplier.name, { font: "bold", size: 18, gray: 0.05 });
  supplier.address.forEach((line, index) => {
    page.text(left, 762 - index * 12, line, { gray: 0.35 });
  });
  page.text(left, 726, supplier.email, { gray: 0.35 });
  page.textRight(right, 776, "INVOICE", { font: "bold", size: 26, gray: 0.05 });

  const facts = [
    ["Invoice number", INVOICE.number],
    ["Invoice date", longDate(INVOICE.invoiceDate)],
    ["Due date", longDate(INVOICE.dueDate)],
    ["Your reference", "PO 1843"],
  ];
  facts.forEach(([label, value], index) => {
    const y = 744 - index * 14;
    page.text(right - 210, y, label, { gray: 0.45 });
    page.textRight(right, y, value, { font: "bold" });
  });

  page.text(left, 668, "BILL TO", { font: "bold", size: 8, gray: 0.45 });
  page.text(left, 652, customer.name, { font: "bold", size: 11 });
  [`Attn. ${customer.attention}`, ...customer.address].forEach((line, index) => {
    page.text(left, 638 - index * 12, line, { gray: 0.3 });
  });

  const columns = {
    description: left + 10,
    quantity: 340,
    price: 420,
    vat: 465,
    amount: right - 10,
  };
  const headerY = 560;
  page.rect(left, headerY - 7, right - left, 22, ACCENT);
  const header = { font: "bold" as const, size: 8.5, gray: 1 };
  page.text(columns.description, headerY, "DESCRIPTION", header);
  page.textRight(columns.quantity, headerY, "QTY", header);
  page.textRight(columns.price, headerY, "UNIT PRICE", header);
  page.textRight(columns.vat + 20, headerY, "VAT", header);
  page.textRight(columns.amount, headerY, "AMOUNT", header);

  let y = headerY - 28;
  INVOICE.lines.forEach((line, index) => {
    if (index % 2 === 1) {
      page.rect(left, y - 8, right - left, 24, [0.96, 0.97, 0.98]);
    }
    page.text(columns.description, y, line.description);
    page.textRight(columns.quantity, y, `${quantity(line.quantity)} ${line.unit}`);
    page.textRight(columns.price, y, money(line.unitPriceCents));
    page.textRight(columns.vat + 20, y, `${line.vatRate}%`);
    page.textRight(columns.amount, y, money(line.netCents), { font: "bold" });
    y -= 24;
  });
  page.line(left, y + 10, right, y + 10);

  y -= 14;
  const totalsLeft = right - 220;
  const totalRow = (label: string, value: string, bold = false) => {
    page.text(totalsLeft, y, label, { gray: bold ? 0.05 : 0.4, font: bold ? "bold" : "regular" });
    page.textRight(columns.amount, y, value, { font: bold ? "bold" : "regular" });
    y -= 16;
  };
  totalRow("Subtotal", money(INVOICE.netCents));
  for (const rate of INVOICE.vat) {
    totalRow(`VAT ${rate.rate}% of ${money(rate.netCents)}`, money(rate.vatCents));
  }
  y -= 4;
  page.rect(totalsLeft - 10, y - 9, right - totalsLeft + 10, 26, [0.93, 0.95, 0.97]);
  y += 2;
  page.text(totalsLeft, y, "Total due", { font: "bold", size: 11 });
  page.textRight(columns.amount, y, money(INVOICE.totalCents), { font: "bold", size: 11 });

  const footerY = 150;
  page.line(left, footerY + 22, right, footerY + 22);
  page.text(left, footerY, "PAYMENT", { font: "bold", size: 8, gray: 0.45 });
  page.text(
    left,
    footerY - 16,
    `Please transfer ${money(INVOICE.totalCents)} by ${longDate(INVOICE.dueDate)}`,
  );
  page.text(left, footerY - 30, `to IBAN ${supplier.iban}, quoting ${INVOICE.number}.`);
  page.text(330, footerY, "COMPANY", { font: "bold", size: 8, gray: 0.45 });
  page.text(330, footerY - 16, `VAT ${supplier.vatNumber}`);
  page.text(330, footerY - 30, `Chamber of Commerce ${supplier.chamberOfCommerce}`);
  page.text(left, 60, "Thank you for your business.", { gray: 0.45 });
  page.textRight(right, 60, "Page 1 of 1", { gray: 0.45, size: 8 });
}

/** The invoice as a one-page PDF; the same bytes each time, so the fixture only changes with it. */
export function renderInvoicePdf(): Uint8Array {
  const page = new Page();
  drawInvoice(page);
  const content = page.content;
  const font = (name: string) =>
    `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    font("Helvetica"),
    font("Helvetica-Bold"),
    `<< /Title ${pdfString(`Invoice ${INVOICE.number}`)} /Author ${pdfString(INVOICE.supplier.name)} >>`,
  ];
  let pdf = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is Latin-1 (the binary comment line) or ASCII, so offsets count bytes.
  return Uint8Array.from(pdf, (character) => character.charCodeAt(0));
}
