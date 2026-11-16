import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";

import { parseAmount } from "../money";
import { parseIban } from "./iban";

/**
 * Reads CAMT.053 bank-to-customer statements, the ISO 20022 statement Dutch and most European
 * banks export, of any version: the elements read here are the same in each, but for the status
 * and party names, which later versions nest one level deeper.
 */

/** Who paid or was paid in a statement entry, and what for. */
export type TransactionPart = {
  /** The counterparty's name; null when the bank gives none, as for its own costs. */
  name: string | null;
  iban: string | null;
  /** The payment's description, e.g. an invoice number. */
  remittance: string;
  endToEndId: string | null;
};

/** An entry of a statement: one amount the balance moved by, of one or more payments. */
export type StatementEntry = {
  /** The bank's reference for the entry. */
  bankReference: string;
  bookingDate: string;
  valueDate: string;
  /** Positive when money came in. */
  amountMinor: bigint;
  /** What the bank adds about the entry, e.g. its own description of a cost. */
  information: string;
  parts: TransactionPart[];
};

export type Statement = {
  /** The bank's ID for the statement. */
  reference: string;
  iban: string;
  currency: string;
  /** The first day it covers. */
  startDate: string;
  /** The last day it covers. */
  endDate: string;
  openingBalanceMinor: bigint;
  closingBalanceMinor: bigint;
  entries: StatementEntry[];
};

/** Why a file is not a statement Bookkeeping can read, as people can act on it. */
class StatementFileError extends Error {}

/** Elements that may repeat, so they always read as lists. */
const LISTS = new Set(["Stmt", "Bal", "Ntry", "NtryDtls", "TxDtls", "Ustrd", "Strd"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  // Keep every value as written: account numbers and references have leading zeros.
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => LISTS.has(name),
});

type Node = Record<string, unknown>;

/**
 * The booked entries of each statement in a CAMT.053 file, with amounts in minor units of the
 * currencies `minorUnitDigits` knows; or why it cannot be read. Pending entries are left out: they
 * have not moved the balance.
 */
export function parseCamt053(
  xml: string,
  minorUnitDigits: (currency: string) => number | null,
): { ok: true; statements: Statement[] } | { ok: false; error: string } {
  try {
    // The parser reads a truncated file as far as it goes, which could make a statement whose
    // balances still add up without its transactions; once imported, its ID would skip the whole
    // file. Only a well-formed document is read.
    try {
      SyntaxValidator.validate(xml);
    } catch {
      // It throws on the first problem. Its types declare the error's class, which it does not
      // export, so nothing tells its errors apart from others.
      throw new StatementFileError(
        "This file is not a complete CAMT.053 bank statement: export it from your bank again.",
      );
    }
    const document: unknown = parser.parse(xml);
    const statements = node(node(document, "Document"), "BkToCstmrStmt")?.Stmt;
    if (!Array.isArray(statements) || statements.length === 0) {
      throw new StatementFileError("This file is not a CAMT.053 bank statement.");
    }
    return {
      ok: true,
      statements: statements.map((statement: Node) => readStatement(statement, minorUnitDigits)),
    };
  } catch (error) {
    if (error instanceof StatementFileError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

function readStatement(
  statement: Node,
  minorUnitDigits: (currency: string) => number | null,
): Statement {
  const reference = text(statement.Id) ?? fail("A statement in this file has no ID.");
  const account = node(statement, "Acct");
  const iban =
    parseIban(text(node(account, "Id")?.IBAN) ?? "") ??
    fail(`Statement ${reference} is not of an account with an IBAN.`);
  const balances = list(statement.Bal);
  const opening =
    balances.find((balance) => balanceType(balance) === "OPBD") ??
    balances.find((balance) => balanceType(balance) === "PRCD") ??
    fail(`Statement ${reference} has no opening balance.`);
  const closing =
    balances.find((balance) => balanceType(balance) === "CLBD") ??
    fail(`Statement ${reference} has no closing balance.`);
  const currency = text(account?.Ccy) ?? currencyOf(opening.Amt, reference);
  const digits =
    minorUnitDigits(currency) ??
    fail(`Statement ${reference} is in ${currency}, which these books do not keep.`);
  const amountOf = (entry: Node, what: string) => {
    if (currencyOf(entry.Amt, reference) !== currency) {
      fail(`Statement ${reference} mixes currencies in ${what}.`);
    }
    const amount =
      parseAmount(text(entry.Amt) ?? "", digits) ??
      fail(`Statement ${reference} has an unreadable amount in ${what}.`);
    return direction(entry, reference) === "CRDT" ? amount : -amount;
  };

  const period = node(statement, "FrToDt");
  const openingDate = dateOf(node(opening, "Dt"), reference);
  const closingDate = dateOf(node(closing, "Dt"), reference);
  const entries = list(statement.Ntry)
    .filter((entry) => {
      const status = entry.Sts;
      return (typeof status === "string" ? status : text(node(entry, "Sts")?.Cd)) === "BOOK";
    })
    .map((entry, position): StatementEntry => {
      const bookingDate =
        dateOf(node(entry, "BookgDt"), reference) ??
        fail(`Statement ${reference} has an entry without a booking date.`);
      const amountMinor = amountOf(entry, `entry ${position + 1}`);
      return {
        bankReference:
          text(entry.AcctSvcrRef) ?? text(entry.NtryRef) ?? `${reference}/${position + 1}`,
        bookingDate,
        valueDate: dateOf(node(entry, "ValDt"), reference) ?? bookingDate,
        amountMinor,
        information: text(entry.AddtlNtryInf) ?? "",
        parts: list(entry.NtryDtls)
          .flatMap((details) => list(details.TxDtls))
          .map((details) => readPart(details, amountMinor > 0n ? "Dbtr" : "Cdtr")),
      };
    });
  // A PRCD balance is the previous period's closing balance, dated that period's last day.
  const openingStart =
    openingDate !== undefined && balanceType(opening) === "PRCD"
      ? dayAfter(openingDate)
      : openingDate;
  const startDate =
    dateOf({ Dt: period?.FrDtTm }, reference) ??
    openingStart ??
    entries[0]?.bookingDate ??
    fail(`Statement ${reference} has no dates.`);
  const endDate =
    dateOf({ Dt: period?.ToDtTm }, reference) ??
    closingDate ??
    fail(`Statement ${reference} has no closing date.`);
  if (endDate < startDate) {
    fail(`Statement ${reference} ends before it starts.`);
  }
  return {
    reference,
    iban,
    currency,
    startDate,
    endDate,
    openingBalanceMinor: amountOf(opening, "its opening balance"),
    closingBalanceMinor: amountOf(closing, "its closing balance"),
    entries,
  };
}

/** A payment of an entry, with the counterparty: who paid for money in, who was paid for out. */
function readPart(details: Node, counterparty: "Dbtr" | "Cdtr"): TransactionPart {
  const parties = node(details, "RltdPties");
  const party = node(parties, counterparty);
  const remittance = node(details, "RmtInf");
  const endToEndId = text(node(details, "Refs")?.EndToEndId);
  return {
    // Later versions put the name in a `Pty` element.
    name: text(party?.Nm) ?? text(node(party, "Pty")?.Nm) ?? null,
    iban: parseIban(text(node(node(parties, `${counterparty}Acct`), "Id")?.IBAN) ?? ""),
    remittance: [
      ...list(remittance?.Ustrd).map((line) => text(line) ?? ""),
      ...list(remittance?.Strd).map(
        (structured) => text(node(structured, "CdtrRefInf")?.Ref) ?? "",
      ),
    ]
      .filter((line) => line !== "")
      .join(" "),
    endToEndId: endToEndId === undefined || endToEndId === "NOTPROVIDED" ? null : endToEndId,
  };
}

function balanceType(balance: Node): string | undefined {
  return text(node(node(balance, "Tp"), "CdOrPrtry")?.Cd);
}

function direction(entry: Node, reference: string): "CRDT" | "DBIT" {
  const indicator = text(entry.CdtDbtInd);
  if (indicator !== "CRDT" && indicator !== "DBIT") {
    fail(`Statement ${reference} has an amount that is neither a credit nor a debit.`);
  }
  return indicator;
}

function currencyOf(amount: unknown, reference: string): string {
  return (
    (typeof amount === "object" && amount !== null ? text((amount as Node)["@Ccy"]) : undefined) ??
    fail(`Statement ${reference} has an amount without a currency.`)
  );
}

/**
 * A date element's day, from its `Dt` or `DtTm`; undefined when it has neither. A date that is
 * there but no day of the calendar, such as 30 February, makes the statement unreadable rather
 * than falling back to another date.
 */
function dateOf(element: Node | undefined, reference: string): string | undefined {
  const value = text(element?.Dt) ?? text(element?.DtTm);
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/u.exec(value);
  if (!match) {
    fail(`Statement ${reference} has an impossible date, ${value}.`);
  }
  const [, year, month, day] = match;
  // Date.UTC carries a day past the month's end into the next month.
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
    fail(`Statement ${reference} has an impossible date, ${value}.`);
  }
  return `${year}-${month}-${day}`;
}

function dayAfter(date: string): string {
  return new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);
}

function node(value: unknown, name: string): Node | undefined {
  const child = typeof value === "object" && value !== null ? (value as Node)[name] : undefined;
  return typeof child === "object" && child !== null && !Array.isArray(child)
    ? (child as Node)
    : undefined;
}

function list(value: unknown): Node[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(
    (item: unknown): Node =>
      typeof item === "object" && item !== null ? (item as Node) : { "#text": item },
  );
}

/** An element's text, whether it has attributes or not; undefined when absent or empty. */
function text(value: unknown): string | undefined {
  const content = typeof value === "object" && value !== null ? (value as Node)["#text"] : value;
  if (typeof content !== "string" && typeof content !== "number") {
    return undefined;
  }
  const trimmed = String(content).trim();
  return trimmed === "" ? undefined : trimmed;
}

function fail(message: string): never {
  throw new StatementFileError(message);
}
