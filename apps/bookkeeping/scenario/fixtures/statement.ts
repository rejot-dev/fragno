import { INVOICE } from "./invoice";

/**
 * Bank statements of Analytical Engines' current account as its bank exports them, in CAMT.053,
 * to import in scenarios or by hand: `pnpm fixtures:generate` writes `statement.xml` beside this
 * file, for 2026. Amounts are in cents; positive is money in.
 */

/** The account the statements are of. */
export const ACCOUNT_IBAN = "NL20INGB0001234567";

export type FixtureEntry = {
  /** The bank's reference for the entry. */
  reference: string;
  bookingDate: string;
  amountCents: number;
  counterparty: { name: string; iban: string } | null;
  remittance: string;
  information: string;
};

export type FixtureStatement = {
  id: string;
  iban: string;
  startDate: string;
  endDate: string;
  openingCents: number;
  entries: FixtureEntry[];
};

/**
 * March's statement in `year`: Lady Byron pays her invoice INV-1, Analytical Engines pays the
 * supplier invoice `INVOICE`, and the bank charges its costs.
 */
export function marchStatement(year: number): FixtureStatement {
  return {
    id: `${year}-03`,
    iban: ACCOUNT_IBAN,
    startDate: `${year}-03-01`,
    endDate: `${year}-03-31`,
    openingCents: 500_000,
    entries: [
      {
        reference: `${year}0305-001`,
        bookingDate: `${year}-03-05`,
        amountCents: 12_100,
        counterparty: { name: "Lady Byron", iban: "NL44RABO0123456789" },
        remittance: "Payment INV-1",
        information: "SEPA Overboeking",
      },
      {
        reference: `${year}0320-001`,
        bookingDate: `${year}-03-20`,
        amountCents: -INVOICE.totalCents,
        counterparty: {
          name: INVOICE.supplier.name,
          iban: INVOICE.supplier.iban.replaceAll(" ", ""),
        },
        remittance: INVOICE.number,
        information: "SEPA Overboeking",
      },
      {
        reference: `${year}0331-001`,
        bookingDate: `${year}-03-31`,
        amountCents: -1_250,
        counterparty: null,
        remittance: "",
        information: "Kosten zakelijk betalingsverkeer",
      },
    ],
  };
}

/** The statement after `statement`, opening with its closing balance, with `entries`. */
export function nextStatement(
  statement: FixtureStatement,
  dates: { id: string; startDate: string; endDate: string },
  entries: FixtureEntry[],
): FixtureStatement {
  return { ...dates, iban: statement.iban, openingCents: closingCents(statement), entries };
}

export function closingCents(statement: FixtureStatement): number {
  return statement.entries.reduce((sum, entry) => sum + entry.amountCents, statement.openingCents);
}

/** The statements as a CAMT.053 file, version 001.02, as Dutch banks export it. */
export function renderCamt053(statements: FixtureStatement[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>${escape(statements.map((statement) => statement.id).join("-"))}</MsgId>
      <CreDtTm>${statements.at(-1)?.endDate ?? "2026-01-01"}T23:59:59</CreDtTm>
    </GrpHdr>
${statements.map(renderStatement).join("\n")}
  </BkToCstmrStmt>
</Document>
`;
}

function renderStatement(statement: FixtureStatement): string {
  return `    <Stmt>
      <Id>${escape(statement.id)}</Id>
      <CreDtTm>${statement.endDate}T23:59:59</CreDtTm>
      <FrToDt>
        <FrDtTm>${statement.startDate}T00:00:00</FrDtTm>
        <ToDtTm>${statement.endDate}T23:59:59</ToDtTm>
      </FrToDt>
      <Acct>
        <Id><IBAN>${statement.iban}</IBAN></Id>
        <Ccy>EUR</Ccy>
      </Acct>
${renderBalance("OPBD", statement.openingCents, statement.startDate)}
${renderBalance("CLBD", closingCents(statement), statement.endDate)}
${statement.entries.map(renderEntry).join("\n")}
    </Stmt>`;
}

function renderBalance(type: "OPBD" | "CLBD", cents: number, date: string): string {
  return `      <Bal>
        <Tp><CdOrPrtry><Cd>${type}</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">${euros(cents)}</Amt>
        <CdtDbtInd>${cents < 0 ? "DBIT" : "CRDT"}</CdtDbtInd>
        <Dt><Dt>${date}</Dt></Dt>
      </Bal>`;
}

function renderEntry(entry: FixtureEntry): string {
  const credit = entry.amountCents > 0;
  const party = credit ? "Dbtr" : "Cdtr";
  const details =
    entry.counterparty === null && entry.remittance === ""
      ? ""
      : `
        <NtryDtls>
          <TxDtls>
            <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>${
              entry.counterparty === null
                ? ""
                : `
            <RltdPties>
              <${party}><Nm>${escape(entry.counterparty.name)}</Nm></${party}>
              <${party}Acct><Id><IBAN>${entry.counterparty.iban}</IBAN></Id></${party}Acct>
            </RltdPties>`
            }${
              entry.remittance === ""
                ? ""
                : `
            <RmtInf><Ustrd>${escape(entry.remittance)}</Ustrd></RmtInf>`
            }
          </TxDtls>
        </NtryDtls>`;
  return `      <Ntry>
        <Amt Ccy="EUR">${euros(entry.amountCents)}</Amt>
        <CdtDbtInd>${credit ? "CRDT" : "DBIT"}</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>${entry.bookingDate}</Dt></BookgDt>
        <ValDt><Dt>${entry.bookingDate}</Dt></ValDt>
        <AcctSvcrRef>${escape(entry.reference)}</AcctSvcrRef>
        <BkTxCd><Prtry><Cd>${credit ? "N541" : "N544"}</Cd><Issr>ABNAMRO</Issr></Prtry></BkTxCd>${details}
        <AddtlNtryInf>${escape(entry.information)}</AddtlNtryInf>
      </Ntry>`;
}

/** Cents as the unsigned decimal CAMT gives amounts in; their sign is the credit or debit. */
function euros(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2);
}

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
