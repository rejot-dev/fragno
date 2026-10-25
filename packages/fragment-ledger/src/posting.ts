import type { FragnoId, FragnoReference } from "@fragno-dev/db/schema";

import type { DatabaseServiceContext, TypedUnitOfWork } from "@fragno-dev/db";

import { LedgerError } from "./errors";
import {
  LEDGER_ID,
  ledgerSchema,
  type AccountRole,
  type CalendarDate,
  type DimensionRules,
  type Side,
} from "./schema";

type LedgerServiceContext = DatabaseServiceContext<{}>;

export type PostingLine = {
  accountId: string;
  side: Side;
  currency: string;
  amountMinor: bigint;
  /** Equal to `amountMinor` when the line is in the functional currency. */
  functionalAmountMinor: bigint;
  description: string;
  /** At most one value per dimension. */
  dimensionValueIds: string[];
  /** Required on control accounts, whose lines are open items of a party; refused elsewhere. */
  openItem: { partyAccountId: string; dueDate: CalendarDate } | null;
};

export type PostEntryInput = {
  journalId: string;
  postingDate: CalendarDate;
  description: string;
  /** Unique in the journal; null for entries without one. */
  reference: string | null;
  /** Opaque actor identifier from the application. */
  postedBy: string;
  /** The document the entry records; posting creates it. */
  source: { kind: string; documentDate: CalendarDate; description: string };
  lines: PostingLine[];
};

export type ReverseEntryInput = {
  entryId: string;
  postingDate: CalendarDate;
  description: string;
  postedBy: string;
};

export type PostedEntry = { id: string; entryNumber: number; lineIds: string[] };

type Reference = FragnoId | FragnoReference;

type LedgerUnitOfWork = TypedUnitOfWork<typeof ledgerSchema>;

/** A validated line, referring to the rows it posts to. */
type RecordedLine = {
  accountId: Reference;
  side: Side;
  currency: Reference;
  amountMinor: bigint;
  functionalAmountMinor: bigint;
  description: string;
  dimensions: { dimensionId: Reference; valueId: Reference }[];
  openItem: { partyAccountId: Reference; dueDate: CalendarDate } | null;
};

type PostingPeriod = {
  id: FragnoId;
  balances: { id: FragnoId; accountId: FragnoReference; debitMinor: bigint; creditMinor: bigint }[];
};

export const postingServices = {
  /**
   * Posts an entry and the source document it records. Entries are validated before they are
   * written and are never changed afterwards: correct one by reversing it.
   */
  postEntry: function (this: LedgerServiceContext, input: PostEntryInput) {
    const accountIds = distinct(input.lines.map((line) => line.accountId));
    const currencyCodes = distinct(input.lines.map((line) => line.currency));
    const valueIds = distinct(input.lines.flatMap((line) => line.dimensionValueIds));
    const partyAccountIds = distinct(
      input.lines.flatMap((line) => (line.openItem ? [line.openItem.partyAccountId] : [])),
    );
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        findPostingPeriod(uow, input.postingDate)
          .findFirst("ledger", (b) => b.whereIndex("primary", (eb) => eb("id", "=", LEDGER_ID)))
          .findFirst("journal", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.journalId)),
          )
          .findFirst("entry", (b) =>
            b
              .whereIndex("idx_entry_journal_reference", (eb) =>
                eb.and(
                  eb("journalId", "=", input.journalId),
                  // Entries without a reference never clash: an empty list finds nothing.
                  eb("reference", "in", input.reference === null ? [] : [input.reference]),
                ),
              )
              .select(["entryNumber"]),
          )
          .find("account", (b) => b.whereIndex("primary", (eb) => eb("id", "in", accountIds)))
          .find("currency", (b) => b.whereIndex("primary", (eb) => eb("id", "in", currencyCodes)))
          .find("dimensionValue", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "in", valueIds))
              .joinOne("dimension", "dimension", (dimension) =>
                dimension
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("dimensionId")))
                  .select(["id"]),
              ),
          )
          .find("partyAccount", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "in", partyAccountIds)),
          ),
      )
      .mutate(
        ({
          uow,
          retrieveResult: [
            period,
            ledger,
            journal,
            referenced,
            accounts,
            currencies,
            values,
            partyAccounts,
          ],
        }) => {
          if (!ledger) {
            throw new LedgerError("LEDGER_NOT_OPEN", "Open the ledger before posting.");
          }
          if (!journal) {
            throw new LedgerError("JOURNAL_NOT_FOUND", "The journal does not exist.");
          }
          if (referenced) {
            throw new LedgerError(
              "ENTRY_REFERENCE_TAKEN",
              `Entry ${journal.code} ${referenced.entryNumber} already has reference ${input.reference}.`,
            );
          }
          const postingPeriod = assertOpenPeriod(period, input.postingDate);

          const lines = input.lines.map((line): RecordedLine => {
            const account = accounts.find((row) => row.id.externalId === line.accountId);
            if (!account) {
              throw new LedgerError(
                "ACCOUNT_NOT_FOUND",
                `Account ${line.accountId} does not exist.`,
              );
            }
            const currency = currencies.find((row) => row.id.externalId === line.currency);
            if (!currency) {
              throw new LedgerError(
                "CURRENCY_NOT_FOUND",
                `Currency ${line.currency} does not exist.`,
              );
            }
            assertAmountInRange(line.amountMinor);
            assertAmountInRange(line.functionalAmountMinor);
            if (line.amountMinor === 0n && line.functionalAmountMinor === 0n) {
              throw new LedgerError("LINE_AMOUNT_ZERO", "A line needs an amount.");
            }
            if (
              sameRow(ledger.functionalCurrency, currency.id) &&
              line.amountMinor !== line.functionalAmountMinor
            ) {
              throw new LedgerError(
                "LINE_FUNCTIONAL_AMOUNT_MISMATCH",
                "A line in the functional currency has one amount.",
              );
            }
            if (!account.active) {
              throw new LedgerError("ACCOUNT_INACTIVE", `Account ${account.code} is inactive.`);
            }
            if (account.currency && !sameRow(account.currency, currency.id)) {
              throw new LedgerError(
                "ACCOUNT_CURRENCY_MISMATCH",
                `Account ${account.code} does not accept ${line.currency}.`,
              );
            }

            return {
              accountId: account.id,
              side: line.side,
              currency: currency.id,
              amountMinor: line.amountMinor,
              functionalAmountMinor: line.functionalAmountMinor,
              description: line.description,
              dimensions: resolveDimensions(account, line.dimensionValueIds, values),
              openItem: resolveOpenItem(account, line.openItem, partyAccounts),
            };
          });

          let debits = 0n;
          let credits = 0n;
          for (const line of lines) {
            if (line.side === "debit") {
              debits += line.functionalAmountMinor;
            } else {
              credits += line.functionalAmountMinor;
            }
          }
          if (debits !== credits) {
            throw new LedgerError(
              "ENTRY_UNBALANCED",
              `Debits (${debits}) and credits (${credits}) must balance.`,
            );
          }

          // The validation above holds only while the accounts are as read.
          for (const account of accounts) {
            uow.check("account", account.id);
          }
          const sourceDocumentId = uow.create("sourceDocument", {
            kind: input.source.kind,
            documentDate: input.source.documentDate,
            description: input.source.description,
          });
          return recordEntry(uow, {
            journal,
            period: postingPeriod,
            sourceDocumentId,
            postingDate: input.postingDate,
            description: input.description,
            reference: input.reference,
            postedBy: input.postedBy,
            reversesEntryId: null,
            lines,
          });
        },
      )
      .build();
  },

  /**
   * Posts the mirror of an entry, in the same journal and for the same source document: every
   * line again, with its side swapped. Account and dimension rules are not checked again: undoing
   * a posted entry stays possible after its accounts are deactivated or their rules change.
   */
  reverseEntry: function (this: LedgerServiceContext, input: ReverseEntryInput) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        findPostingPeriod(uow, input.postingDate).findFirst("entry", (b) =>
          b
            .whereIndex("primary", (eb) => eb("id", "=", input.entryId))
            .joinOne("journal", "journal", (journal) =>
              journal.onIndex("primary", (eb) => eb("id", "=", eb.parent("journalId"))),
            )
            .joinOne("reversal", "entry", (reversal) =>
              reversal
                .onIndex("idx_entry_reverses", (eb) => eb("reversesEntryId", "=", eb.parent("id")))
                .select(["id"]),
            )
            .joinMany("lines", "line", (line) =>
              line
                .onIndex("idx_line_entry_number", (eb) => eb("entryId", "=", eb.parent("id")))
                .orderByIndex("idx_line_entry_number", "asc")
                .joinMany("dimensions", "lineDimension", (dimension) =>
                  dimension.onIndex("idx_line_dimension_line", (eb) =>
                    eb("lineId", "=", eb.parent("id")),
                  ),
                )
                .joinOne("openItem", "openItem", (openItem) =>
                  openItem.onIndex("idx_open_item_line", (eb) =>
                    eb("lineId", "=", eb.parent("id")),
                  ),
                ),
            ),
        ),
      )
      .mutate(({ uow, retrieveResult: [period, entry] }) => {
        // The join always finds the journal: entries reference theirs.
        if (!entry?.journal) {
          throw new LedgerError("ENTRY_NOT_FOUND", "The entry does not exist.");
        }
        if (entry.reversal) {
          throw new LedgerError("ENTRY_ALREADY_REVERSED", "The entry is already reversed.");
        }
        return recordEntry(uow, {
          journal: entry.journal,
          period: assertOpenPeriod(period, input.postingDate),
          sourceDocumentId: entry.sourceDocumentId,
          postingDate: input.postingDate,
          description: input.description,
          reference: null,
          postedBy: input.postedBy,
          reversesEntryId: entry.id,
          lines: entry.lines.map((line) => ({
            accountId: line.accountId,
            side: line.side === "debit" ? "credit" : "debit",
            currency: line.currency,
            amountMinor: line.amountMinor,
            functionalAmountMinor: line.functionalAmountMinor,
            description: line.description,
            dimensions: line.dimensions.map((dimension) => ({
              dimensionId: dimension.dimensionId,
              valueId: dimension.valueId,
            })),
            openItem: line.openItem && {
              partyAccountId: line.openItem.partyAccountId,
              dueDate: line.openItem.dueDate,
            },
          })),
        });
      })
      .build();
  },
};

/**
 * The dimension values a line carries, which must satisfy its account's rules: one value at most
 * per dimension, required dimensions present, forbidden ones absent.
 */
/**
 * The largest amount of a line or allocation, in minor units: fifteen digits, which keeps
 * balances, the sums of many amounts, far within the database's 64-bit integers.
 */
const MAX_AMOUNT_MINOR = 999_999_999_999_999n;

export function assertAmountInRange(amountMinor: bigint): void {
  if (amountMinor < 0n || amountMinor > MAX_AMOUNT_MINOR) {
    throw new LedgerError(
      "AMOUNT_OUT_OF_RANGE",
      `Amounts are from 0 to ${MAX_AMOUNT_MINOR} minor units.`,
    );
  }
}

function resolveDimensions(
  account: { code: string; dimensionRules: DimensionRules },
  valueIds: string[],
  values: { id: FragnoId; dimension: { id: FragnoId } | null }[],
): RecordedLine["dimensions"] {
  const dimensions = valueIds.map((valueId) => {
    const value = values.find((row) => row.id.externalId === valueId);
    // The join always finds the dimension: dimension values reference theirs.
    if (!value?.dimension) {
      throw new LedgerError(
        "DIMENSION_VALUE_NOT_FOUND",
        `Dimension value ${valueId} does not exist.`,
      );
    }
    return { dimensionId: value.dimension.id, valueId: value.id };
  });
  const dimensionIds = dimensions.map((dimension) => dimension.dimensionId.externalId);
  if (new Set(dimensionIds).size !== dimensionIds.length) {
    throw new LedgerError("DIMENSION_REPEATED", "A line has at most one value per dimension.");
  }
  for (const [dimensionId, requirement] of Object.entries(account.dimensionRules)) {
    if ((requirement === "required") !== dimensionIds.includes(dimensionId)) {
      throw new LedgerError(
        "DIMENSION_RULE_VIOLATED",
        `Dimension ${dimensionId} is ${requirement} on account ${account.code}.`,
      );
    }
  }
  return dimensions;
}

/**
 * The open item a line is: lines on control accounts are open items of a party account that
 * posts to that control account, and no other line is.
 */
function resolveOpenItem(
  account: { id: FragnoId; code: string; role: AccountRole },
  openItem: PostingLine["openItem"],
  partyAccounts: { id: FragnoId; code: string; controlAccountId: FragnoReference }[],
): RecordedLine["openItem"] {
  if (account.role === "ordinary") {
    if (openItem) {
      throw new LedgerError(
        "OPEN_ITEM_NOT_ALLOWED",
        `Account ${account.code} is not a control account.`,
      );
    }
    return null;
  }
  if (!openItem) {
    throw new LedgerError(
      "OPEN_ITEM_REQUIRED",
      `Lines on control account ${account.code} need a party.`,
    );
  }
  const partyAccount = partyAccounts.find((row) => row.id.externalId === openItem.partyAccountId);
  if (!partyAccount) {
    throw new LedgerError(
      "PARTY_ACCOUNT_NOT_FOUND",
      `Party account ${openItem.partyAccountId} does not exist.`,
    );
  }
  if (!sameRow(partyAccount.controlAccountId, account.id)) {
    throw new LedgerError(
      "PARTY_ACCOUNT_MISMATCH",
      `Party account ${partyAccount.code} posts to another control account.`,
    );
  }
  return { partyAccountId: partyAccount.id, dueDate: openItem.dueDate };
}

/**
 * Adds the read of the period a posting date falls in: the latest period starting on or before
 * it, with its balances. Periods never overlap, but there can be gaps between fiscal years, so
 * `assertOpenPeriod` still checks the period's end.
 */
function findPostingPeriod(uow: LedgerUnitOfWork, postingDate: CalendarDate) {
  return uow.findFirst("period", (b) =>
    b
      .whereIndex("idx_period_start", (eb) => eb("startDate", "<=", postingDate))
      .orderByIndex("idx_period_start", "desc")
      .joinMany("balances", "balance", (balance) =>
        balance.onIndex("idx_balance_period_account", (eb) => eb("periodId", "=", eb.parent("id"))),
      ),
  );
}

function assertOpenPeriod<
  TPeriod extends PostingPeriod & { endDate: CalendarDate; status: string },
>(period: TPeriod | null, postingDate: CalendarDate): TPeriod {
  if (!period || period.endDate < postingDate || period.status !== "open") {
    throw new LedgerError("POSTING_PERIOD_NOT_OPEN", `No open period contains ${postingDate}.`);
  }
  return period;
}

/**
 * Writes a validated entry: claims the journal's next entry number, creates the entry, its
 * lines and open items, and adds the lines to the period's balances. Every counter it updates
 * is version-checked, as is the period, so a concurrent post, close, or allocation retries.
 */
function recordEntry(
  uow: Pick<LedgerUnitOfWork, "create" | "update" | "check" | "now">,
  entry: {
    journal: { id: FragnoId; lastEntryNumber: number };
    period: PostingPeriod;
    sourceDocumentId: Reference;
    postingDate: CalendarDate;
    description: string;
    reference: string | null;
    postedBy: string;
    reversesEntryId: FragnoId | null;
    lines: RecordedLine[];
  },
): PostedEntry {
  const entryNumber = entry.journal.lastEntryNumber + 1;
  uow.update("journal", entry.journal.id, (b) => b.set({ lastEntryNumber: entryNumber }).check());
  uow.check("period", entry.period.id);

  const entryId = uow.create("entry", {
    journalId: entry.journal.id,
    entryNumber,
    sourceDocumentId: entry.sourceDocumentId,
    postingDate: entry.postingDate,
    periodId: entry.period.id,
    description: entry.description,
    reference: entry.reference,
    postedAt: uow.now(),
    postedBy: entry.postedBy,
    reversesEntryId: entry.reversesEntryId,
  });

  const lineIds = entry.lines.map((line, index) => {
    const lineId = uow.create("line", {
      entryId,
      number: index + 1,
      accountId: line.accountId,
      side: line.side,
      currency: line.currency,
      amountMinor: line.amountMinor,
      functionalAmountMinor: line.functionalAmountMinor,
      description: line.description,
      postingDate: entry.postingDate,
    });
    for (const dimension of line.dimensions) {
      uow.create("lineDimension", {
        lineId,
        dimensionId: dimension.dimensionId,
        valueId: dimension.valueId,
      });
    }
    if (line.openItem) {
      uow.create("openItem", {
        lineId,
        partyAccountId: line.openItem.partyAccountId,
        side: line.side,
        currency: line.currency,
        dueDate: line.openItem.dueDate,
        outstandingMinor: line.amountMinor,
      });
    }
    return lineId.valueOf();
  });

  const totals = new Map<
    bigint,
    { accountId: Reference; debitMinor: bigint; creditMinor: bigint }
  >();
  for (const line of entry.lines) {
    const key = internalId(line.accountId);
    const total = totals.get(key) ?? { accountId: line.accountId, debitMinor: 0n, creditMinor: 0n };
    if (line.side === "debit") {
      total.debitMinor += line.functionalAmountMinor;
    } else {
      total.creditMinor += line.functionalAmountMinor;
    }
    totals.set(key, total);
  }
  for (const [key, total] of totals) {
    const balance = entry.period.balances.find((row) => row.accountId.internalId === key);
    if (balance) {
      uow.update("balance", balance.id, (b) =>
        b
          .set({
            debitMinor: balance.debitMinor + total.debitMinor,
            creditMinor: balance.creditMinor + total.creditMinor,
          })
          .check(),
      );
    } else {
      uow.create(
        "balance",
        {
          periodId: entry.period.id,
          accountId: total.accountId,
          debitMinor: total.debitMinor,
          creditMinor: total.creditMinor,
        },
        // Another posting created the account's first balance in this period: retrying reads it.
        // Physical table names carry the namespace, so the index is recognized by its columns.
        {
          retryOnUniqueConflict: ({ error }) =>
            error.columns?.length === 2 &&
            error.columns.includes("periodId") &&
            error.columns.includes("accountId"),
        },
      );
    }
  }

  return { id: entryId.valueOf(), entryNumber, lineIds };
}

/** Whether a reference and a retrieved row are the same row. */
function sameRow(reference: FragnoReference, id: FragnoId): boolean {
  return reference.internalId === internalId(id);
}

function internalId(row: Reference): bigint {
  // Rows read from the database always carry their internal ID.
  return row.internalId!;
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}
