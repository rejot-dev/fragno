import { z } from "zod";

import {
  accountRoles,
  accountTypes,
  dimensionRequirements,
  partyRoles,
  periodStatuses,
  sides,
} from "./schema";

/** What the ledger shows of its data. */

const calendarDate = z.iso.date();
const side = z.enum(sides);

export const ledgerView = z.object({ name: z.string(), functionalCurrency: z.string() });

export const currencyView = z.object({ code: z.string(), minorUnitDigits: z.number() });

export const fiscalYearView = z.object({
  id: z.string(),
  number: z.number(),
  name: z.string(),
  startDate: calendarDate,
  endDate: calendarDate,
  periods: z.array(
    z.object({
      id: z.string(),
      number: z.number(),
      startDate: calendarDate,
      endDate: calendarDate,
      status: z.enum(periodStatuses),
    }),
  ),
});

export const accountView = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  type: z.enum(accountTypes),
  role: z.enum(accountRoles),
  normalSide: side,
  currency: z.string().nullable(),
  active: z.boolean(),
  dimensionRules: z.record(z.string(), z.enum(dimensionRequirements)),
});

export const journalView = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  lastEntryNumber: z.number(),
});

export const dimensionView = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  values: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
});

export const partyView = z.object({
  id: z.string(),
  name: z.string(),
  accounts: z.array(
    z.object({
      id: z.string(),
      role: z.enum(partyRoles),
      code: z.string(),
      controlAccountId: z.string(),
    }),
  ),
});

/** A source document and every entry recording it, reversals included, oldest first. */
export const sourceDocumentView = z.object({
  id: z.string(),
  kind: z.string(),
  documentDate: calendarDate,
  description: z.string(),
  entries: z.array(
    z.object({
      id: z.string(),
      journalId: z.string(),
      entryNumber: z.number(),
      postingDate: calendarDate,
      reversesEntryId: z.string().nullable(),
      reversedByEntryId: z.string().nullable(),
    }),
  ),
});

/**
 * The views that show amounts, with `amount` as their minor units: bigints from the services,
 * exact at any size, and strings of digits over HTTP, as JSON numbers are exact only to 2^53.
 */
function amountViews<TAmount extends z.ZodType>(amount: TAmount) {
  const entryView = z.object({
    id: z.string(),
    entryNumber: z.number(),
    postingDate: calendarDate,
    periodId: z.string(),
    description: z.string(),
    reference: z.string().nullable(),
    postedAt: z.date(),
    postedBy: z.string(),
    /** Reversals post to their entry's journal, so their numbers are in the same journal. */
    reverses: z.object({ id: z.string(), entryNumber: z.number() }).nullable(),
    reversedBy: z.object({ id: z.string(), entryNumber: z.number() }).nullable(),
    sourceDocument: z.object({
      id: z.string(),
      kind: z.string(),
      documentDate: calendarDate,
      description: z.string(),
    }),
    lines: z.array(
      z.object({
        id: z.string(),
        number: z.number(),
        accountId: z.string(),
        side,
        currency: z.string(),
        amountMinor: amount,
        functionalAmountMinor: amount,
        description: z.string(),
        dimensionValueIds: z.array(z.string()),
        openItem: z.object({ id: z.string(), partyAccountId: z.string() }).nullable(),
      }),
    ),
  });

  const accountLineView = z.object({
    id: z.string(),
    entryId: z.string(),
    journalId: z.string(),
    entryNumber: z.number(),
    postingDate: calendarDate,
    side,
    currency: z.string(),
    amountMinor: amount,
    functionalAmountMinor: amount,
    description: z.string(),
  });

  const openItemView = z.object({
    id: z.string(),
    lineId: z.string(),
    entry: z.object({
      id: z.string(),
      journalId: z.string(),
      entryNumber: z.number(),
      postingDate: calendarDate,
      /** The line's description, else the entry's. */
      description: z.string(),
    }),
    side,
    currency: z.string(),
    dueDate: calendarDate,
    amountMinor: amount,
    outstandingMinor: amount,
    /** Allocations on this item's side; reversed ones stay listed. */
    allocations: z.array(
      z.object({
        id: z.string(),
        debitItemId: z.string(),
        creditItemId: z.string(),
        amountMinor: amount,
        allocatedAt: z.date(),
        allocatedBy: z.string(),
        reversed: z.boolean(),
      }),
    ),
  });

  const trialBalanceRowView = z.object({
    accountId: z.string(),
    code: z.string(),
    name: z.string(),
    debitMinor: amount,
    creditMinor: amount,
  });

  return { entryView, accountLineView, openItemView, trialBalanceRowView };
}

const serviceViews = amountViews(z.bigint());

/** The views with amounts as routes send them; `toHttp` converts the services' views. */
export const httpViews = amountViews(z.string().regex(/^\d+$/u));

/** `T` as routes send it: bigints become strings of digits. */
type Http<T> = T extends bigint
  ? string
  : T extends Date
    ? T
    : T extends readonly (infer TItem)[]
      ? Http<TItem>[]
      : T extends object
        ? { [K in keyof T]: Http<T[K]> }
        : T;

export function toHttp<T>(value: T): Http<T> {
  return convertBigints(value) as Http<T>;
}

function convertBigints(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(convertBigints);
  }
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, convertBigints(field)]),
    );
  }
  return value;
}

export function pageView<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), cursor: z.string().nullable() });
}

export type LedgerView = z.infer<typeof ledgerView>;
export type CurrencyView = z.infer<typeof currencyView>;
export type FiscalYearView = z.infer<typeof fiscalYearView>;
export type AccountView = z.infer<typeof accountView>;
export type JournalView = z.infer<typeof journalView>;
export type DimensionView = z.infer<typeof dimensionView>;
export type PartyView = z.infer<typeof partyView>;
export type SourceDocumentView = z.infer<typeof sourceDocumentView>;
export type EntryView = z.infer<typeof serviceViews.entryView>;
export type AccountLineView = z.infer<typeof serviceViews.accountLineView>;
export type OpenItemView = z.infer<typeof serviceViews.openItemView>;
export type TrialBalanceRowView = z.infer<typeof serviceViews.trialBalanceRowView>;
export type Page<T> = { items: T[]; cursor: string | null };
