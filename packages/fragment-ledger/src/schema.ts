import { column, idColumn, referenceColumn, schema, type Column } from "@fragno-dev/db/schema";

/** What an account is in the books; drives reporting. */
export const accountTypes = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountType = (typeof accountTypes)[number];

/**
 * The posting behaviour the ledger enforces: receivable and payable accounts are control accounts,
 * whose lines are open items of a party.
 */
export const accountRoles = ["ordinary", "receivable", "payable"] as const;
export type AccountRole = (typeof accountRoles)[number];

/** Only assets can be receivable and only liabilities payable. */
export type AccountClassification =
  | { type: "asset"; role: "ordinary" | "receivable" }
  | { type: "liability"; role: "ordinary" | "payable" }
  | { type: "equity" | "revenue" | "expense"; role: "ordinary" };

export const sides = ["debit", "credit"] as const;
export type Side = (typeof sides)[number];

/** Closed periods can reopen for corrections; locked periods (returns filed) cannot. */
export const periodStatuses = ["open", "closed", "locked"] as const;
export type PeriodStatus = (typeof periodStatuses)[number];

/** Customers post to a receivable control account, suppliers to a payable one. */
export const partyRoles = ["customer", "supplier"] as const;
export type PartyRole = (typeof partyRoles)[number];

export const dimensionRequirements = ["required", "forbidden"] as const;
export type DimensionRequirement = (typeof dimensionRequirements)[number];

/** Keyed by dimension ID. A dimension without a rule is optional on the account. */
export type DimensionRules = Record<string, DimensionRequirement>;

/** An ISO calendar date, `YYYY-MM-DD`; sorts as text. */
export type CalendarDate = string;

function stringColumn<T extends string>() {
  return column("string") as unknown as Column<"string", T, T>;
}

function jsonColumn<T>() {
  return column("json") as unknown as Column<"json", T, T>;
}

/**
 * One ledger per database (or namespace): no table carries a ledger column. Amounts are integers
 * in minor units, as bigints: Postgres integers stop at 21 million euros in cents.
 *
 * The ledger's rules live in its services, not in the database: entries are validated before they
 * are written, and only ever written posted. Rules spanning rows rely on optimistic concurrency:
 * counters (entry numbers, outstanding amounts, balances) are updated with version checks, and
 * posting checks the versions of the period and accounts it validated against.
 */
export const ledgerSchema = schema("ledger", (s) => {
  return (
    s
      .addTable("currency", (t) => {
        // The ID is the ISO 4217 code.
        return t.addColumn("id", idColumn()).addColumn("minorUnitDigits", column("integer"));
      })
      // A single row, with ID `LEDGER_ID`.
      .addTable("ledger", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("name", column("string"))
          .addColumn("functionalCurrency", referenceColumn({ table: "currency" }));
      })
      // Fiscal years chain without gaps: year n + 1 starts the day after year n ends, so the
      // unique number makes two concurrent years conflict.
      .addTable("fiscalYear", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("number", column("integer"))
          .addColumn("name", column("string"))
          .addColumn("startDate", stringColumn<CalendarDate>())
          .addColumn("endDate", stringColumn<CalendarDate>())
          .createIndex("idx_fiscal_year_number", ["number"], { unique: true })
          .createIndex("idx_fiscal_year_name", ["name"], { unique: true });
      })
      // A year's periods partition it, so every date in a year has exactly one period.
      .addTable("period", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("fiscalYearId", referenceColumn({ table: "fiscalYear" }))
          .addColumn("number", column("integer"))
          .addColumn("startDate", stringColumn<CalendarDate>())
          .addColumn("endDate", stringColumn<CalendarDate>())
          .addColumn("status", stringColumn<PeriodStatus>())
          .createIndex("idx_period_year_number", ["fiscalYearId", "number"], { unique: true })
          .createIndex("idx_period_start", ["startDate"], { unique: true });
      })
      .addTable("account", (t) => {
        return (
          t
            .addColumn("id", idColumn())
            .addColumn("code", column("string"))
            .addColumn("name", column("string"))
            .addColumn("type", stringColumn<AccountType>())
            .addColumn("normalSide", stringColumn<Side>())
            .addColumn("role", stringColumn<AccountRole>())
            // Null: the account accepts postings in any currency.
            .addColumn("currency", referenceColumn({ table: "currency" }).nullable())
            .addColumn("active", column("bool"))
            .addColumn("dimensionRules", jsonColumn<DimensionRules>())
            .createIndex("idx_account_code", ["code"], { unique: true })
        );
      })
      .addTable("journal", (t) => {
        return (
          t
            .addColumn("id", idColumn())
            .addColumn("code", column("string"))
            .addColumn("name", column("string"))
            // Entry numbers are gapless per journal: posting claims the next one by updating this
            // counter with a version check.
            .addColumn("lastEntryNumber", column("integer"))
            .createIndex("idx_journal_code", ["code"], { unique: true })
        );
      })
      .addTable("dimension", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("code", column("string"))
          .addColumn("name", column("string"))
          .createIndex("idx_dimension_code", ["code"], { unique: true });
      })
      .addTable("dimensionValue", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("dimensionId", referenceColumn({ table: "dimension" }))
          .addColumn("code", column("string"))
          .addColumn("name", column("string"))
          .createIndex("idx_dimension_value_code", ["dimensionId", "code"], { unique: true });
      })
      .addTable("party", (t) => {
        return t.addColumn("id", idColumn()).addColumn("name", column("string"));
      })
      .addTable("partyAccount", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("partyId", referenceColumn({ table: "party" }))
          .addColumn("role", stringColumn<PartyRole>())
          .addColumn("code", column("string"))
          .addColumn("controlAccountId", referenceColumn({ table: "account" }))
          .createIndex("idx_party_account_party_role", ["partyId", "role"], { unique: true })
          .createIndex("idx_party_account_role_code", ["role", "code"], { unique: true });
      })
      .addTable("sourceDocument", (t) => {
        return (
          t
            .addColumn("id", idColumn())
            // Opaque to the ledger: what produced the entries, e.g. `manual_journal` or `invoice`.
            .addColumn("kind", column("string"))
            .addColumn("documentDate", stringColumn<CalendarDate>())
            .addColumn("description", column("string"))
        );
      })
      .addTable("entry", (t) => {
        return (
          t
            .addColumn("id", idColumn())
            .addColumn("journalId", referenceColumn({ table: "journal" }))
            .addColumn("entryNumber", column("integer"))
            .addColumn("sourceDocumentId", referenceColumn({ table: "sourceDocument" }))
            .addColumn("postingDate", stringColumn<CalendarDate>())
            .addColumn("periodId", referenceColumn({ table: "period" }))
            .addColumn("description", column("string"))
            // The application's reference for the entry, e.g. an invoice number. It is unique in
            // the journal, so posting the same entry again is refused instead of posting it twice.
            .addColumn("reference", column("string").nullable())
            .addColumn("postedAt", column("timestamp"))
            // Opaque actor identifier from the application.
            .addColumn("postedBy", column("string"))
            .addColumn("reversesEntryId", referenceColumn({ table: "entry" }).nullable())
            .createIndex("idx_entry_journal_number", ["journalId", "entryNumber"], { unique: true })
            .createIndex("idx_entry_journal_reference", ["journalId", "reference"], {
              unique: true,
            })
            .createIndex("idx_entry_reverses", ["reversesEntryId"], { unique: true })
            .createIndex("idx_entry_source", ["sourceDocumentId"])
        );
      })
      // Transaction and functional amounts are separate snapshots. A zero functional amount is
      // possible for tiny foreign amounts; a zero transaction amount for FX adjustments.
      .addTable("line", (t) => {
        return (
          t
            .addColumn("id", idColumn())
            .addColumn("entryId", referenceColumn({ table: "entry" }))
            .addColumn("number", column("integer"))
            .addColumn("accountId", referenceColumn({ table: "account" }))
            .addColumn("side", stringColumn<Side>())
            .addColumn("currency", referenceColumn({ table: "currency" }))
            .addColumn("amountMinor", column("bigint"))
            .addColumn("functionalAmountMinor", column("bigint"))
            .addColumn("description", column("string"))
            // Copied from the entry, so an account's lines read in date order without a join.
            .addColumn("postingDate", stringColumn<CalendarDate>())
            .createIndex("idx_line_entry_number", ["entryId", "number"], { unique: true })
            .createIndex("idx_line_account_date", ["accountId", "postingDate"])
        );
      })
      .addTable("lineDimension", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("lineId", referenceColumn({ table: "line" }))
          .addColumn("dimensionId", referenceColumn({ table: "dimension" }))
          .addColumn("valueId", referenceColumn({ table: "dimensionValue" }))
          .createIndex("idx_line_dimension_line", ["lineId", "dimensionId"], { unique: true })
          .createIndex("idx_line_dimension_value", ["valueId"]);
      })
      // A line on a control account is an open item of the party that owns the account. Side and
      // currency are copied from the line, which never changes; the outstanding amount, in the
      // line's currency, drops as allocations settle the item.
      .addTable("openItem", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("lineId", referenceColumn({ table: "line" }))
          .addColumn("partyAccountId", referenceColumn({ table: "partyAccount" }))
          .addColumn("side", stringColumn<Side>())
          .addColumn("currency", referenceColumn({ table: "currency" }))
          .addColumn("dueDate", stringColumn<CalendarDate>())
          .addColumn("outstandingMinor", column("bigint"))
          .createIndex("idx_open_item_line", ["lineId"], { unique: true })
          .createIndex("idx_open_item_party_due", ["partyAccountId", "dueDate"]);
      })
      // Settles a debit open item against a credit open item of the same party account, in
      // their shared currency. Append-only: a reversal undoes it.
      .addTable("allocation", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("debitItemId", referenceColumn({ table: "openItem" }))
          .addColumn("creditItemId", referenceColumn({ table: "openItem" }))
          .addColumn("amountMinor", column("bigint"))
          .addColumn("allocatedAt", column("timestamp"))
          .addColumn("allocatedBy", column("string"))
          .createIndex("idx_allocation_debit", ["debitItemId"])
          .createIndex("idx_allocation_credit", ["creditItemId"]);
      })
      .addTable("allocationReversal", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("allocationId", referenceColumn({ table: "allocation" }))
          .addColumn("reversedAt", column("timestamp"))
          .addColumn("reversedBy", column("string"))
          .createIndex("idx_allocation_reversal_allocation", ["allocationId"], { unique: true });
      })
      // Functional-currency totals per account and period, kept by posting, so balances read
      // without summing lines.
      .addTable("balance", (t) => {
        return t
          .addColumn("id", idColumn())
          .addColumn("periodId", referenceColumn({ table: "period" }))
          .addColumn("accountId", referenceColumn({ table: "account" }))
          .addColumn("debitMinor", column("bigint"))
          .addColumn("creditMinor", column("bigint"))
          .createIndex("idx_balance_period_account", ["periodId", "accountId"], { unique: true });
      })
  );
});

export const LEDGER_ID = "ledger";
