import type { AppActionTokenClaims } from "@fragno-dev/backoffice-api/v0/app-actions";
import type { AppAction } from "@fragno-dev/backoffice-api/v0/apps";
import {
  BackofficeApiRequestError,
  BackofficeApiUnreachableError,
} from "@fragno-dev/backoffice-api/v0/client";
import { organizationRoleSchema } from "@fragno-dev/backoffice-api/v0/organization";
import { accountTypes, dimensionRequirements, partyRoles, sides } from "@fragno-dev/ledger/schema";
import { z } from "zod";

import type { Books, Outcome } from "../books/books";
import { DOCUMENT_MEDIA_TYPES } from "../books/documents/schema";
import { dayAfter, PERIOD_LENGTHS, periodEndDates } from "../books/fiscal-years";
import { decimalAmount, parseAmount } from "../books/money";
import { CONTROL_ROLES, usualControlAccount } from "../books/parties";
import type { Administration } from "../directory/directory";
import {
  canManage,
  MEMBERSHIP_CONFIRMATION_LIFETIME_MS,
  membershipThrough,
} from "../directory/membership";
import { exchangeForScope, isBackofficeUnavailable } from "./client";
import { releaseDocument, sharedDocumentPath } from "./document-shares";

/**
 * The actions Backoffice agents keep an administration's books with. They run in the
 * administration's Backoffice project, which names its books, or in the project of the bookkeeping
 * agent of the firm keeping them, which names the administration; inputs and outputs name the
 * books' records by code and amounts as decimals, as people do. Closing and locking periods stay
 * with people, in Bookkeeping's pages.
 */

type BooksStub = ReturnType<CloudflareEnv["BOOKS"]["getByName"]>;
type Described = Awaited<ReturnType<Books["describe"]>>;

/** The person an action that changes the books acts for. */
type Person = { name: string };

/**
 * Where a call runs: the administration's own project, whose workspace holds its documents' files,
 * or its firm's agent project, which reads a document's file where Bookkeeping shares it.
 */
type Workplace = {
  documentPath(document: { id: string; storageKey: string }): Promise<string>;
};

const ADMINISTRATION_PROJECT: Workplace = { documentPath: async (document) => document.storageKey };

function firmAgentProject(administration: Administration): Workplace {
  return { documentPath: (document) => sharedDocumentPath(administration.id, document) };
}

/** Every action's input names the administration when the call runs in a firm's agent project. */
const administrationInput = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The administration's ID. A firm's bookkeeping agent names the administration whose books it keeps; leave it out in the administration's own project.",
  );

/**
 * Who answers a document's review: the bookkeeping agent, which Bookkeeping prompts as its
 * installation so that it can answer reviews and nothing else, answers the request asking it; a
 * person answers whether asked or not.
 */
type Answerer = { kind: "bookkeeping-agent" } | { kind: "person"; person: Person };

/** The request an answer is to, and who gave it. */
function answering(
  answerer: Answerer,
  request: string | null,
): { request: string | null; by: string } {
  switch (answerer.kind) {
    case "person":
      return { request, by: answerer.person.name };
    case "bookkeeping-agent":
      if (request === null) {
        refuse("Give the ID of the request you answer as `request`: the request names it.");
      }
      return { request, by: "the bookkeeping agent" };
  }
  throw new Error("Unsupported answerer.");
}

const requestInput = z
  .string()
  .min(1)
  .nullable()
  .describe("The ID of the request asking you about the document; null when nobody asked you.");

/** Answers the action with `status` and a message Backoffice shows the agent. */
class ActionFailure extends Error {
  readonly status: 400 | 403 | 422 | 503;

  constructor(status: 400 | 403 | 422 | 503, message: string) {
    super(message);
    this.status = status;
  }
}

function refuse(message: string): never {
  throw new ActionFailure(422, message);
}

/** The value of a ledger operation, or its refusal as the action's answer. */
function settled<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) {
    refuse(outcome.message);
  }
  return outcome.value;
}

/**
 * Who may run an action: `read` anyone Backoffice signs for; `review`, which answers a document's
 * review and posts nothing, people and Bookkeeping's installation; `keep` people; and `set-up`
 * owners and admins.
 */
type BooksAction = { declaration: AppAction } & (
  | {
      access: "read";
      run(books: BooksStub, input: unknown, workplace: Workplace): Promise<unknown>;
    }
  | {
      access: "review";
      run(books: BooksStub, input: unknown, answerer: Answerer): Promise<{ document: string }>;
    }
  | {
      access: "keep" | "set-up";
      run(books: BooksStub, input: unknown, person: Person): Promise<unknown>;
    }
);

type ActionDefinition<TInput extends z.ZodObject, TOutput extends z.ZodType> = {
  id: string;
  label: string;
  description: string;
  input: TInput;
  output: TOutput;
};

/** Declares the action from its schemas, so what Backoffice validates is what the handler parses. */
function declare(definition: ActionDefinition<z.ZodObject, z.ZodType>): AppAction {
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.input.extend({ administration: administrationInput }), {
      io: "input",
    }),
    outputSchema: z.toJSONSchema(definition.output, { io: "output" }),
  };
}

function parse<TInput extends z.ZodType>(schema: TInput, input: unknown): z.output<TInput> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ActionFailure(400, z.prettifyError(parsed.error));
  }
  return parsed.data;
}

function readAction<TInput extends z.ZodObject, TOutput extends z.ZodType>(
  definition: ActionDefinition<TInput, TOutput> & {
    run(books: BooksStub, input: z.output<TInput>, workplace: Workplace): Promise<z.input<TOutput>>;
  },
): BooksAction {
  return {
    declaration: declare(definition),
    access: "read",
    run: (books, input, workplace) =>
      definition.run(books, parse(definition.input, input), workplace),
  };
}

/** An action answering a document's review, which says which document it answered. */
function reviewAction<TInput extends z.ZodObject, TOutput extends z.ZodType<{ document: string }>>(
  definition: ActionDefinition<TInput, TOutput> & {
    run(books: BooksStub, input: z.output<TInput>, answerer: Answerer): Promise<z.input<TOutput>>;
  },
): BooksAction {
  return {
    declaration: declare(definition),
    access: "review",
    run: async (books, input, answerer) =>
      definition.output.parse(
        await definition.run(books, parse(definition.input, input), answerer),
      ),
  };
}

function writeAction<TInput extends z.ZodObject, TOutput extends z.ZodType>(
  access: "keep" | "set-up",
  definition: ActionDefinition<TInput, TOutput> & {
    run(books: BooksStub, input: z.output<TInput>, person: Person): Promise<z.input<TOutput>>;
  },
): BooksAction {
  return {
    declaration: declare(definition),
    access,
    run: (books, input, person) => definition.run(books, parse(definition.input, input), person),
  };
}

/** The books' records by code, and the codes of the records the ledger names by ID. */
function indexBooks(books: Described) {
  function byCode<T extends { code: string }>(rows: T[], kind: string) {
    return (code: string): T =>
      rows.find((row) => row.code === code) ?? refuse(`The books have no ${kind} ${code}.`);
  }
  function codeOf(rows: { id: string; code: string }[]) {
    const codes = new Map(rows.map((row) => [row.id, row.code]));
    // The ledger only refers to records of these books.
    return (id: string) => codes.get(id)!;
  }
  const partyAccounts = books.parties.flatMap((party) => party.accounts);
  const values = books.dimensions.flatMap((dimension) =>
    dimension.values.map((value) => ({ ...value, dimension })),
  );
  const fiscalYear = (name: string) =>
    books.fiscalYears.find((year) => year.name === name) ??
    refuse(`The books have no fiscal year ${name}.`);
  return {
    journal: byCode(books.journals, "journal"),
    account: byCode(books.accounts, "account"),
    dimension: byCode(books.dimensions, "dimension"),
    partyAccount: (role: "customer" | "supplier", code: string) =>
      partyAccounts.find((account) => account.role === role && account.code === code) ??
      refuse(`The books have no ${role} ${code}.`),
    fiscalYear,
    period: (yearName: string, number: number) =>
      fiscalYear(yearName).periods.find((period) => period.number === number) ??
      refuse(`Fiscal year ${yearName} has no period ${number}.`),
    minorUnitDigits: (currency: string) =>
      books.currencies.find((row) => row.code === currency)?.minorUnitDigits ??
      refuse(`The books have no currency ${currency}.`),
    journalCode: codeOf(books.journals),
    accountCode: codeOf(books.accounts),
    partyAccountOf: (id: string) => {
      const { role, code } = partyAccounts.find((account) => account.id === id)!;
      return { role, code };
    },
    valueOf: (id: string) => values.find((value) => value.id === id)!,
    /** Rules keyed by dimension code, as agents name them, from the ledger's by dimension ID. */
    rulesByCode: (rules: Record<string, "required" | "forbidden">) =>
      Object.fromEntries(
        Object.entries(rules).map(([id, rule]) => [codeOf(books.dimensions)(id), rule]),
      ),
    rulesById: (rules: Record<string, "required" | "forbidden">) =>
      Object.fromEntries(
        Object.entries(rules).map(([code, rule]) => [
          byCode(books.dimensions, "dimension")(code).id,
          rule,
        ]),
      ),
  };
}

type Index = ReturnType<typeof indexBooks>;

/**
 * The minor units of `text`, a decimal with at most the currency's digits. Zero is an amount: a
 * line may have one of its two amounts zero, and the ledger refuses what it does not take.
 */
function minorUnits(text: string, digits: number, what: string): bigint {
  const amount = parseAmount(text, digits);
  if (amount === null) {
    refuse(`Enter ${what} as a decimal with at most ${digits} decimals, like 1234.50.`);
  }
  return amount;
}

const decimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/u)
  .describe("A decimal amount with a dot and no thousands separators, e.g. 1234.50.");
const dimensionRules = z
  .record(z.string(), z.enum(dimensionRequirements))
  .describe(
    "By dimension code: whether lines on the account need a value of it or may not have one. Dimensions left out are optional.",
  );
const cursor = z
  .string()
  .nullable()
  .describe("Null for the first page; the previous page's cursor for the next.");

const entryOutput = z.object({
  journal: z.string(),
  number: z.number().int(),
  postingDate: z.iso.date(),
  reference: z.string().nullable(),
  description: z.string(),
  postedBy: z.string(),
  postedAt: z.string().describe("When it was posted, as an ISO timestamp."),
  reverses: z.number().int().nullable().describe("The number of the entry this one reverses."),
  reversedBy: z.number().int().nullable().describe("The number of the entry reversing this one."),
  lines: z.array(
    z.object({
      account: z.string(),
      description: z.string(),
      side: z.enum(sides),
      amount: z.string(),
      currency: z.string(),
      functionalAmount: z.string().describe("The amount in the books' functional currency."),
      party: z.object({ role: z.enum(partyRoles), code: z.string() }).nullable(),
      dimensions: z.record(z.string(), z.string()).describe("Value codes by dimension code."),
    }),
  ),
});

type EntryView = Awaited<ReturnType<Books["listEntries"]>>["items"][number];

function entryOutputOf(
  entry: EntryView,
  journal: string,
  index: Index,
  books: Described,
): z.input<typeof entryOutput> {
  return {
    journal,
    number: entry.entryNumber,
    postingDate: entry.postingDate,
    reference: entry.reference,
    description: entry.description,
    postedBy: entry.postedBy,
    postedAt: entry.postedAt.toISOString(),
    reverses: entry.reverses?.entryNumber ?? null,
    reversedBy: entry.reversedBy?.entryNumber ?? null,
    lines: entry.lines.map((line) => ({
      account: index.accountCode(line.accountId),
      description: line.description,
      side: line.side,
      amount: decimalAmount(line.amountMinor, index.minorUnitDigits(line.currency)),
      currency: line.currency,
      functionalAmount: decimalAmount(
        line.functionalAmountMinor,
        index.minorUnitDigits(books.functionalCurrency),
      ),
      party: line.openItem && index.partyAccountOf(line.openItem.partyAccountId),
      dimensions: Object.fromEntries(
        line.dimensionValueIds.map((valueId) => {
          const value = index.valueOf(valueId);
          return [value.dimension.code, value.code];
        }),
      ),
    })),
  };
}

const entryInput = z.strictObject({
  journal: z.string().trim().min(1).max(20).describe("The journal's code."),
  postingDate: z.iso.date().describe("Must fall in an open period."),
  reference: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .nullable()
    .describe("Unique in the journal, e.g. an invoice number; null for none."),
  description: z.string().trim().min(1).max(500),
  lines: z
    .array(
      z.strictObject({
        account: z.string().trim().min(1).max(20).describe("The account's code."),
        side: z.enum(sides),
        amount: decimal.describe("In the line's currency."),
        currency: z.string().nullable().describe("Null for the books' functional currency."),
        functionalAmount: decimal
          .nullable()
          .describe(
            "The amount in the functional currency, for lines in another currency; null otherwise.",
          ),
        description: z.string().trim().max(500),
        party: z
          .string()
          .trim()
          .min(1)
          .max(20)
          .nullable()
          .describe(
            "On receivable and payable accounts, the code of the customer or supplier; null on other accounts.",
          ),
        dueDate: z.iso
          .date()
          .nullable()
          .describe("When a customer's or supplier's line falls due; null for the posting date."),
        dimensions: z
          .record(z.string(), z.string())
          .describe("Value codes by dimension code, as the account's dimension rules ask."),
      }),
    )
    .min(2),
});

type PostingLine = Parameters<Books["postEntry"]>[0]["lines"][number];

/**
 * The ledger's lines for an entry that names the books' records by code, refusing codes the books
 * lack and amounts that do not fit their currency. A control-account line without a party has no
 * open item; the ledger refuses posting it with its own message.
 */
function ledgerLinesOf(
  input: z.output<typeof entryInput>,
  index: Index,
  described: Described,
): PostingLine[] {
  const functionalDigits = index.minorUnitDigits(described.functionalCurrency);
  return input.lines.map((line, position) => {
    const label = `Line ${position + 1}`;
    const account = index.account(line.account);
    const currency = line.currency ?? described.functionalCurrency;
    const amountMinor = minorUnits(
      line.amount,
      index.minorUnitDigits(currency),
      `${label}'s amount`,
    );
    const foreign = currency !== described.functionalCurrency;
    if (foreign !== (line.functionalAmount !== null)) {
      refuse(
        foreign
          ? `${label} is in ${currency}: give its functional amount in ${described.functionalCurrency}.`
          : `${label} is in the functional currency: its functional amount is null.`,
      );
    }
    const partyRole =
      account.role === "receivable" ? "customer" : account.role === "payable" ? "supplier" : null;
    if (partyRole === null && line.party !== null) {
      refuse(`${label}: account ${account.code} is not a customer or supplier account.`);
    }
    return {
      accountId: account.id,
      side: line.side,
      currency,
      amountMinor,
      functionalAmountMinor:
        line.functionalAmount === null
          ? amountMinor
          : minorUnits(line.functionalAmount, functionalDigits, `${label}'s functional amount`),
      description: line.description,
      dimensionValueIds: Object.entries(line.dimensions).map(([dimensionCode, valueCode]) => {
        const dimension = index.dimension(dimensionCode);
        return (
          dimension.values.find((value) => value.code === valueCode)?.id ??
          refuse(`Dimension ${dimension.code} has no value ${valueCode}.`)
        );
      }),
      openItem:
        partyRole === null || line.party === null
          ? null
          : {
              partyAccountId: index.partyAccount(partyRole, line.party).id,
              dueDate: line.dueDate ?? input.postingDate,
            },
    };
  });
}

/** The document `id`, or the refusal an agent can act on. */
async function requireDocument(books: BooksStub, id: string) {
  return (await books.getDocument(id)) ?? refuse(`The books have no document ${id}.`);
}

const BOOKS_ACTION_LIST: BooksAction[] = [
  readAction({
    id: "books.describe",
    label: "Describe the books",
    description:
      "The administration's books: their functional currency and other currencies, fiscal years and their periods with their status, journals, chart of accounts with each account's dimension rules, dimensions and their values, and customers and suppliers. Read this first: other actions name these records by code.",
    input: z.strictObject({}),
    output: z.object({
      name: z.string(),
      functionalCurrency: z.string(),
      currencies: z.array(z.object({ code: z.string(), minorUnitDigits: z.number().int() })),
      fiscalYears: z.array(
        z.object({
          name: z.string(),
          startDate: z.iso.date(),
          endDate: z.iso.date(),
          periods: z.array(
            z.object({
              number: z.number().int(),
              startDate: z.iso.date(),
              endDate: z.iso.date(),
              status: z.enum(["open", "closed", "locked"]),
            }),
          ),
        }),
      ),
      journals: z.array(
        z.object({ code: z.string(), name: z.string(), entryCount: z.number().int() }),
      ),
      accounts: z.array(
        z.object({
          code: z.string(),
          name: z.string(),
          type: z.enum(accountTypes),
          role: z
            .enum(["ordinary", "receivable", "payable"])
            .describe(
              "Receivable and payable accounts are customers' and suppliers' control accounts.",
            ),
          normalSide: z.enum(sides),
          currency: z.string().nullable().describe("Null: the account takes any currency."),
          active: z.boolean(),
          dimensionRules,
        }),
      ),
      dimensions: z.array(
        z.object({
          code: z.string(),
          name: z.string(),
          values: z.array(z.object({ code: z.string(), name: z.string() })),
        }),
      ),
      parties: z.array(
        z.object({
          name: z.string(),
          accounts: z.array(
            z.object({ role: z.enum(partyRoles), code: z.string(), controlAccount: z.string() }),
          ),
        }),
      ),
    }),
    async run(books) {
      const described = await books.describe();
      const index = indexBooks(described);
      return {
        name: described.name,
        functionalCurrency: described.functionalCurrency,
        currencies: described.currencies,
        fiscalYears: described.fiscalYears.map((year) => ({
          name: year.name,
          startDate: year.startDate,
          endDate: year.endDate,
          periods: year.periods.map(({ number, startDate, endDate, status }) => ({
            number,
            startDate,
            endDate,
            status,
          })),
        })),
        journals: described.journals.map((journal) => ({
          code: journal.code,
          name: journal.name,
          entryCount: journal.lastEntryNumber,
        })),
        accounts: described.accounts.map((account) => ({
          code: account.code,
          name: account.name,
          type: account.type,
          role: account.role,
          normalSide: account.normalSide,
          currency: account.currency,
          active: account.active,
          dimensionRules: index.rulesByCode(account.dimensionRules),
        })),
        dimensions: described.dimensions.map((dimension) => ({
          code: dimension.code,
          name: dimension.name,
          values: dimension.values.map((value) => ({ code: value.code, name: value.name })),
        })),
        parties: described.parties.map((party) => ({
          name: party.name,
          accounts: party.accounts.map((account) => ({
            role: account.role,
            code: account.code,
            controlAccount: index.accountCode(account.controlAccountId),
          })),
        })),
      };
    },
  }),

  readAction({
    id: "entries.list",
    label: "List a journal's entries",
    description:
      "A journal's entries, newest first, 50 at a time, with their lines. Pass the returned cursor to read the next page.",
    input: z.strictObject({
      journal: z.string().trim().min(1).max(20).describe("The journal's code."),
      cursor,
    }),
    output: z.object({
      entries: z.array(entryOutput),
      cursor: z.string().nullable().describe("Null on the last page."),
    }),
    async run(books, input) {
      const described = await books.describe();
      const index = indexBooks(described);
      const journal = index.journal(input.journal);
      const page = await books.listEntries({ journalId: journal.id, cursor: input.cursor });
      return {
        entries: page.items.map((entry) => entryOutputOf(entry, journal.code, index, described)),
        cursor: page.cursor,
      };
    },
  }),

  readAction({
    id: "entries.get",
    label: "Read an entry",
    description: "One entry of a journal, by its number, with its lines.",
    input: z.strictObject({
      journal: z.string().trim().min(1).max(20),
      number: z.number().int().positive(),
    }),
    output: entryOutput,
    async run(books, input) {
      const described = await books.describe();
      const index = indexBooks(described);
      const journal = index.journal(input.journal);
      const entry = await books.getEntry({ journalId: journal.id, entryNumber: input.number });
      if (!entry) {
        refuse(`Journal ${journal.code} has no entry ${input.number}.`);
      }
      return entryOutputOf(entry, journal.code, index, described);
    },
  }),

  readAction({
    id: "accounts.lines",
    label: "List an account's lines",
    description:
      "The lines posted to an account, latest posting date first, 50 at a time. Pass the returned cursor to read the next page.",
    input: z.strictObject({
      account: z.string().trim().min(1).max(20).describe("The account's code."),
      cursor,
    }),
    output: z.object({
      lines: z.array(
        z.object({
          journal: z.string(),
          entry: z.number().int(),
          postingDate: z.iso.date(),
          description: z.string(),
          side: z.enum(sides),
          amount: z.string(),
          currency: z.string(),
          functionalAmount: z.string(),
        }),
      ),
      cursor: z.string().nullable(),
    }),
    async run(books, input) {
      const described = await books.describe();
      const index = indexBooks(described);
      const account = index.account(input.account);
      const page = await books.listAccountLines({ accountId: account.id, cursor: input.cursor });
      return {
        lines: page.items.map((line) => ({
          journal: index.journalCode(line.journalId),
          entry: line.entryNumber,
          postingDate: line.postingDate,
          description: line.description,
          side: line.side,
          amount: decimalAmount(line.amountMinor, index.minorUnitDigits(line.currency)),
          currency: line.currency,
          functionalAmount: decimalAmount(
            line.functionalAmountMinor,
            index.minorUnitDigits(described.functionalCurrency),
          ),
        })),
        cursor: page.cursor,
      };
    },
  }),

  readAction({
    id: "reports.trial-balance",
    label: "Trial balance",
    description:
      "Each account's debit and credit totals in the functional currency, for the fiscal year through one of its periods.",
    input: z.strictObject({
      fiscalYear: z.string().describe("The fiscal year's name."),
      period: z.number().int().positive().describe("The period's number in the fiscal year."),
    }),
    output: z.object({
      accounts: z.array(
        z.object({ code: z.string(), name: z.string(), debit: z.string(), credit: z.string() }),
      ),
      totals: z.object({ debit: z.string(), credit: z.string() }),
    }),
    async run(books, input) {
      const described = await books.describe();
      const index = indexBooks(described);
      const period = index.period(input.fiscalYear, input.period);
      const rows = await books.getTrialBalance({ periodId: period.id });
      const digits = index.minorUnitDigits(described.functionalCurrency);
      const total = (side: "debitMinor" | "creditMinor") =>
        decimalAmount(
          rows.reduce((sum, row) => sum + row[side], 0n),
          digits,
        );
      return {
        accounts: rows.map((row) => ({
          code: row.code,
          name: row.name,
          debit: decimalAmount(row.debitMinor, digits),
          credit: decimalAmount(row.creditMinor, digits),
        })),
        totals: { debit: total("debitMinor"), credit: total("creditMinor") },
      };
    },
  }),

  readAction({
    id: "parties.open-items",
    label: "List a customer's or supplier's open items",
    description:
      "A customer's or supplier's open items, settled ones included: what each one came from, its due date, amount, and what is outstanding, with the settlements on it. Settle items with settlements.create using their IDs.",
    input: z.strictObject({
      role: z.enum(partyRoles),
      code: z.string().trim().min(1).max(20).describe("The customer's or supplier's code."),
    }),
    output: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          journal: z.string(),
          entry: z.number().int(),
          postingDate: z.iso.date(),
          description: z.string(),
          dueDate: z.iso.date(),
          side: z.enum(sides),
          currency: z.string(),
          amount: z.string(),
          outstanding: z.string(),
          settlements: z.array(
            z.object({
              id: z.string(),
              debitItem: z.string(),
              creditItem: z.string(),
              amount: z.string(),
              settledAt: z.string(),
              settledBy: z.string(),
              reversed: z.boolean(),
            }),
          ),
        }),
      ),
    }),
    async run(books, input) {
      const index = indexBooks(await books.describe());
      const partyAccount = index.partyAccount(input.role, input.code);
      const items = await books.listOpenItems({ partyAccountId: partyAccount.id });
      return {
        items: items.map((item) => {
          const digits = index.minorUnitDigits(item.currency);
          return {
            id: item.id,
            journal: index.journalCode(item.entry.journalId),
            entry: item.entry.entryNumber,
            postingDate: item.entry.postingDate,
            description: item.entry.description,
            dueDate: item.dueDate,
            side: item.side,
            currency: item.currency,
            amount: decimalAmount(item.amountMinor, digits),
            outstanding: decimalAmount(item.outstandingMinor, digits),
            settlements: item.allocations.map((allocation) => ({
              id: allocation.id,
              debitItem: allocation.debitItemId,
              creditItem: allocation.creditItemId,
              amount: decimalAmount(allocation.amountMinor, digits),
              settledAt: allocation.allocatedAt.toISOString(),
              settledBy: allocation.allocatedBy,
              reversed: allocation.reversed,
            })),
          };
        }),
      };
    },
  }),

  readAction({
    id: "documents.get",
    label: "Describe a document",
    description:
      "A document uploaded to the books, such as an invoice or receipt: where its file is, to read with models.extract, and whether it is to book, booked, or dismissed.",
    input: z.strictObject({ document: z.uuid().describe("The document's ID.") }),
    output: z.object({
      id: z.string(),
      filename: z.string(),
      path: z
        .string()
        .describe(
          "The file's path: in the administration's own project, in its workspace; in a firm's agent project, where Bookkeeping shares it while the agent is asked about it.",
        ),
      mediaType: z.enum(DOCUMENT_MEDIA_TYPES),
      uploadedAt: z.string().describe("When it was uploaded, as an ISO timestamp."),
      uploadedBy: z.string(),
      status: z.enum(["to-book", "booked", "dismissed"]),
      bookedIn: z
        .object({ journal: z.string(), number: z.number().int() })
        .nullable()
        .describe("The entry booking it, while it is booked."),
      documentDate: z.iso
        .date()
        .nullable()
        .describe("The date it was first booked with, which booking it again keeps."),
      review: z
        .enum(["requested", "proposed", "declined"])
        .nullable()
        .describe(
          "Whether the bookkeeping agent was asked about it, proposed an entry, or proposed none.",
        ),
    }),
    async run(books, input, workplace) {
      const document = await requireDocument(books, input.document);
      const { state, source } = document;
      const index = indexBooks(await books.describe());
      const booking =
        state.status === "booked"
          ? source!.entries.find((entry) => entry.id === state.entryId)!
          : null;
      return {
        id: document.id,
        filename: document.filename,
        path: await workplace.documentPath(document),
        mediaType: document.mediaType,
        uploadedAt: document.uploadedAt.toISOString(),
        uploadedBy: document.uploadedBy,
        status: state.status,
        bookedIn: booking && {
          journal: index.journalCode(booking.journalId),
          number: booking.entryNumber,
        },
        documentDate: source?.documentDate ?? null,
        review: document.review?.status ?? null,
      };
    },
  }),

  writeAction("keep", {
    id: "entries.post",
    label: "Post an entry",
    description:
      "Posts a balanced entry to a journal. Posted entries are final: correct one with entries.reverse. Lines on a receivable or payable account name the customer or supplier they belong to. Give the entry a reference, such as the invoice number, when it has one: a journal refuses a reference it already has, so posting again after a lost answer cannot post twice.",
    input: entryInput,
    output: z.object({ journal: z.string(), number: z.number().int() }),
    async run(books, input, person) {
      const described = await books.describe();
      const index = indexBooks(described);
      const journal = index.journal(input.journal);
      const lines = ledgerLinesOf(input, index, described);
      const posted = settled(
        await books.postEntry({
          journalId: journal.id,
          postingDate: input.postingDate,
          description: input.description,
          reference: input.reference,
          postedBy: person.name,
          source: {
            type: "new",
            id: crypto.randomUUID(),
            kind: "backoffice",
            documentDate: input.postingDate,
            description: input.description,
          },
          lines,
        }),
      );
      return { journal: journal.code, number: posted.entryNumber };
    },
  }),

  writeAction("keep", {
    id: "entries.reverse",
    label: "Reverse an entry",
    description:
      "Corrects a posted entry by posting its mirror in the same journal: every line again with its side swapped. An entry is reversed at most once.",
    input: z.strictObject({
      journal: z.string().trim().min(1).max(20),
      number: z.number().int().positive().describe("The number of the entry to reverse."),
      postingDate: z.iso
        .date()
        .describe("The reversal's posting date; must fall in an open period."),
      description: z.string().trim().min(1).max(500),
    }),
    output: z.object({ journal: z.string(), number: z.number().int() }),
    async run(books, input, person) {
      const index = indexBooks(await books.describe());
      const journal = index.journal(input.journal);
      const entry =
        (await books.getEntry({ journalId: journal.id, entryNumber: input.number })) ??
        refuse(`Journal ${journal.code} has no entry ${input.number}.`);
      const reversal = settled(
        await books.reverseEntry({
          entryId: entry.id,
          sourceDocument: entry.sourceDocument,
          postingDate: input.postingDate,
          description: input.description,
          postedBy: person.name,
        }),
      );
      return { journal: journal.code, number: reversal.entryNumber };
    },
  }),

  writeAction("keep", {
    id: "parties.create",
    label: "Add a customer or supplier",
    description:
      "Makes a party a customer or a supplier with its own code: a new party with a name, or an existing party that is already the other, e.g. a customer that also supplies.",
    input: z.strictObject({
      party: z
        .union([
          z.strictObject({
            name: z.string().trim().min(1).max(160).describe("A new party's name."),
          }),
          z.strictObject({
            role: z.enum(partyRoles),
            code: z
              .string()
              .trim()
              .min(1)
              .max(20)
              .describe("The code the existing party has as a customer or supplier."),
          }),
        ])
        .describe("A new party, or an existing one by its other role's code."),
      role: z.enum(partyRoles),
      code: z
        .string()
        .trim()
        .min(1)
        .max(20)
        .describe("Unique among the books' customers or suppliers."),
      controlAccount: z
        .string()
        .trim()
        .min(1)
        .max(20)
        .nullable()
        .describe(
          "The receivable (customers) or payable (suppliers) account it posts to; null for the books' only one.",
        ),
    }),
    output: z.object({ role: z.enum(partyRoles), code: z.string(), controlAccount: z.string() }),
    async run(books, input) {
      const described = await books.describe();
      const index = indexBooks(described);
      const controlAccount =
        input.controlAccount === null
          ? (usualControlAccount(described.accounts, input.role) ??
            refuse(`Name the ${CONTROL_ROLES[input.role]} account ${input.role}s post to.`))
          : index.account(input.controlAccount);
      let party: { name: string } | { id: string };
      if ("name" in input.party) {
        party = { name: input.party.name };
      } else {
        const other = index.partyAccount(input.party.role, input.party.code);
        party = { id: described.parties.find((row) => row.accounts.includes(other))!.id };
      }
      settled(
        await books.createPartyAccount({
          party,
          role: input.role,
          code: input.code,
          controlAccountId: controlAccount.id,
        }),
      );
      return { role: input.role, code: input.code, controlAccount: controlAccount.code };
    },
  }),

  writeAction("keep", {
    id: "settlements.create",
    label: "Settle open items",
    description:
      "Settles a customer's or supplier's debit open item against a credit one, such as an invoice against its payment. Find the items' IDs with parties.open-items.",
    input: z.strictObject({
      role: z.enum(partyRoles),
      code: z.string().trim().min(1).max(20).describe("The customer's or supplier's code."),
      debitItem: z.string().describe("The debit open item's ID."),
      creditItem: z.string().describe("The credit open item's ID."),
      amount: decimal
        .nullable()
        .describe("In the items' currency; null settles all both items have outstanding."),
    }),
    output: z.object({ id: z.string().describe("The settlement's ID."), amount: z.string() }),
    async run(books, input, person) {
      const index = indexBooks(await books.describe());
      const partyAccount = index.partyAccount(input.role, input.code);
      const items = await books.listOpenItems({ partyAccountId: partyAccount.id });
      const item = (id: string) =>
        items.find((row) => row.id === id) ??
        refuse(`${input.role} ${input.code} has no open item ${id}.`);
      const debit = item(input.debitItem);
      item(input.creditItem);
      const digits = index.minorUnitDigits(debit.currency);
      const allocation = settled(
        await books.allocate({
          debitItemId: input.debitItem,
          creditItemId: input.creditItem,
          amountMinor:
            input.amount === null ? null : minorUnits(input.amount, digits, "the amount"),
          allocatedBy: person.name,
        }),
      );
      return { id: allocation.id, amount: decimalAmount(allocation.amountMinor, digits) };
    },
  }),

  writeAction("keep", {
    id: "settlements.reverse",
    label: "Undo a settlement",
    description: "Undoes a settlement, restoring what both its items have outstanding.",
    input: z.strictObject({ settlement: z.string().describe("The settlement's ID.") }),
    output: z.object({}),
    async run(books, input, person) {
      settled(
        await books.reverseAllocation({ allocationId: input.settlement, reversedBy: person.name }),
      );
      return {};
    },
  }),

  reviewAction({
    id: "documents.propose",
    label: "Propose a document's entry",
    description:
      "Proposes the entry that books a document to book, for a person to review and book: it posts nothing. The entry is as entries.post takes it, except that a customer's or supplier's line may leave its party null when the books lack them. It must balance in the functional currency. An answer to a request counts only while the document awaits it; one to no request replaces the earlier answer.",
    input: z.strictObject({
      document: z.uuid().describe("The document's ID."),
      request: requestInput,
      documentDate: z.iso
        .date()
        .describe("The date printed on the document, e.g. its invoice date."),
      entry: entryInput,
      note: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe(
          "For the person reviewing: what the document is, how you chose the accounts, and what to check, such as a supplier the books lack.",
        ),
    }),
    output: z.object({ document: z.string(), review: z.literal("proposed") }),
    async run(books, input, answerer) {
      const { request, by } = answering(answerer, input.request);
      const described = await books.describe();
      const index = indexBooks(described);
      const journal = index.journal(input.entry.journal);
      const lines = ledgerLinesOf(input.entry, index, described);
      const inactive = input.entry.lines.find((line) => !index.account(line.account).active);
      if (inactive) {
        refuse(`Account ${inactive.account} is inactive and takes no new lines.`);
      }
      const functionalDigits = index.minorUnitDigits(described.functionalCurrency);
      const total = (side: "debit" | "credit") =>
        lines
          .filter((line) => line.side === side)
          .reduce((sum, line) => sum + line.functionalAmountMinor, 0n);
      if (total("debit") !== total("credit")) {
        refuse(
          `The entry does not balance: debits ${decimalAmount(total("debit"), functionalDigits)} and credits ${decimalAmount(total("credit"), functionalDigits)} ${described.functionalCurrency}.`,
        );
      }
      settled(
        await books.answerReview({
          documentId: input.document,
          request,
          answer: {
            status: "proposed",
            entry: {
              journalId: journal.id,
              postingDate: input.entry.postingDate,
              documentDate: input.documentDate,
              reference: input.entry.reference,
              description: input.entry.description,
              lines: lines.map((line, position) => ({
                accountId: line.accountId,
                description: line.description,
                side: line.side,
                amount: decimalAmount(line.amountMinor, index.minorUnitDigits(line.currency)),
                currency: line.currency,
                functionalAmount: decimalAmount(line.functionalAmountMinor, functionalDigits),
                partyAccountId: line.openItem?.partyAccountId ?? null,
                dueDate: input.entry.lines[position].dueDate,
                dimensionValueIds: line.dimensionValueIds,
              })),
            },
            note: input.note,
            by,
            at: new Date().toISOString(),
          },
        }),
      );
      return { document: input.document, review: "proposed" as const };
    },
  }),

  reviewAction({
    id: "documents.decline",
    label: "Propose no entry for a document",
    description:
      "Says why you propose no entry for a document to book, such as a file that is no invoice or receipt, or one you cannot read, so a person books it themselves. An answer to a request counts only while the document awaits it; one to no request replaces the earlier answer.",
    input: z.strictObject({
      document: z.uuid().describe("The document's ID."),
      request: requestInput,
      reason: z.string().trim().min(1).max(2000).describe("Why, for the person who books it."),
    }),
    output: z.object({ document: z.string(), review: z.literal("declined") }),
    async run(books, input, answerer) {
      const { request, by } = answering(answerer, input.request);
      await requireDocument(books, input.document);
      settled(
        await books.answerReview({
          documentId: input.document,
          request,
          answer: {
            status: "declined",
            reason: input.reason,
            by,
            at: new Date().toISOString(),
          },
        }),
      );
      return { document: input.document, review: "declined" as const };
    },
  }),

  writeAction("set-up", {
    id: "accounts.create",
    label: "Add an account",
    description:
      "Adds an account to the chart of accounts. Its type, role, normal side, and currency never change afterwards.",
    input: z.strictObject({
      code: z.string().trim().min(1).max(20),
      name: z.string().trim().min(1).max(160),
      type: z.enum(accountTypes),
      role: z
        .enum(["ordinary", "receivable", "payable"])
        .describe(
          "receivable: customers' control account, for assets. payable: suppliers' control account, for liabilities. ordinary otherwise.",
        ),
      normalSide: z
        .enum(sides)
        .nullable()
        .describe(
          "Null for the type's usual side: debit for assets and expenses, credit otherwise.",
        ),
      currency: z.string().nullable().describe("The only currency it takes; null for any."),
      dimensionRules,
    }),
    output: z.object({ code: z.string() }),
    async run(books, input) {
      const index = indexBooks(await books.describe());
      const classification = { type: input.type, role: input.role };
      if (
        (classification.role === "receivable" && classification.type !== "asset") ||
        (classification.role === "payable" && classification.type !== "liability")
      ) {
        refuse("Receivable accounts are assets and payable accounts are liabilities.");
      }
      settled(
        await books.createAccount({
          code: input.code,
          name: input.name,
          // Checked above: receivable accounts are assets, payable ones liabilities.
          classification: classification as Parameters<Books["createAccount"]>[0]["classification"],
          normalSide:
            input.normalSide ??
            (input.type === "asset" || input.type === "expense" ? "debit" : "credit"),
          currency: input.currency,
          dimensionRules: index.rulesById(input.dimensionRules),
        }),
      );
      return { code: input.code };
    },
  }),

  writeAction("set-up", {
    id: "accounts.update",
    label: "Change an account",
    description:
      "Renames an account, activates or deactivates it, or changes its dimension rules. Inactive accounts take no new lines.",
    input: z.strictObject({
      account: z.string().trim().min(1).max(20),
      name: z.string().trim().min(1).max(160),
      active: z.boolean(),
      dimensionRules,
    }),
    output: z.object({ code: z.string() }),
    async run(books, input) {
      const index = indexBooks(await books.describe());
      const account = index.account(input.account);
      settled(
        await books.updateAccount({
          accountId: account.id,
          name: input.name,
          active: input.active,
          dimensionRules: index.rulesById(input.dimensionRules),
        }),
      );
      return { code: account.code };
    },
  }),

  writeAction("set-up", {
    id: "journals.create",
    label: "Add a journal",
    description: "Adds a journal; each journal numbers its entries without gaps.",
    input: z.strictObject({
      code: z.string().trim().min(1).max(20),
      name: z.string().trim().min(1).max(160),
    }),
    output: z.object({ code: z.string() }),
    async run(books, input) {
      settled(await books.createJournal({ code: input.code, name: input.name }));
      return { code: input.code };
    },
  }),

  writeAction("set-up", {
    id: "dimensions.create",
    label: "Add a dimension",
    description: "Adds a dimension lines can be analysed by, such as a cost centre or project.",
    input: z.strictObject({
      code: z.string().trim().min(1).max(20),
      name: z.string().trim().min(1).max(160),
    }),
    output: z.object({ code: z.string() }),
    async run(books, input) {
      settled(await books.createDimension({ code: input.code, name: input.name }));
      return { code: input.code };
    },
  }),

  writeAction("set-up", {
    id: "dimension-values.create",
    label: "Add a dimension value",
    description: "Adds a value to a dimension, such as one cost centre.",
    input: z.strictObject({
      dimension: z.string().trim().min(1).max(20).describe("The dimension's code."),
      code: z.string().trim().min(1).max(20),
      name: z.string().trim().min(1).max(160),
    }),
    output: z.object({ dimension: z.string(), code: z.string() }),
    async run(books, input) {
      const dimension = indexBooks(await books.describe()).dimension(input.dimension);
      settled(
        await books.createDimensionValue({
          dimensionId: dimension.id,
          code: input.code,
          name: input.name,
        }),
      );
      return { dimension: dimension.code, code: input.code };
    },
  }),

  writeAction("set-up", {
    id: "currencies.add",
    label: "Add a currency",
    description: "Adds a currency lines can be in, besides the functional currency.",
    input: z.strictObject({
      code: z
        .string()
        .regex(/^[A-Z]{3}$/u)
        .describe("Its ISO 4217 code, e.g. USD."),
      minorUnitDigits: z.number().int().min(0).max(4).describe("Its decimals, e.g. 2 for USD."),
    }),
    output: z.object({ code: z.string() }),
    async run(books, input) {
      settled(await books.addCurrency(input));
      return { code: input.code };
    },
  }),

  writeAction("set-up", {
    id: "fiscal-years.open",
    label: "Open the next fiscal year",
    description:
      "Opens the twelve months after the last fiscal year, in monthly or quarterly periods or as one period. Its periods are open.",
    input: z.strictObject({
      name: z.string().trim().min(1).max(40).describe("e.g. 2027."),
      periodLength: z.enum(Object.keys(PERIOD_LENGTHS) as [keyof typeof PERIOD_LENGTHS]),
    }),
    output: z.object({ name: z.string(), startDate: z.iso.date(), endDate: z.iso.date() }),
    async run(books, input) {
      // Opening the books opens their first fiscal year.
      const last = (await books.describe()).fiscalYears.at(-1)!;
      const startDate = dayAfter(last.endDate);
      const endDates = periodEndDates(startDate, input.periodLength);
      settled(
        await books.openFiscalYear({ name: input.name, startDate, periodEndDates: endDates }),
      );
      return { name: input.name, startDate, endDate: endDates.at(-1)! };
    },
  }),

  writeAction("set-up", {
    id: "periods.reopen",
    label: "Reopen a closed period",
    description:
      "Reopens a closed period so entries can be posted in it again. Locked periods stay locked. Closing and locking periods is left to people, in Bookkeeping.",
    input: z.strictObject({
      fiscalYear: z.string().describe("The fiscal year's name."),
      period: z.number().int().positive().describe("The period's number in the fiscal year."),
    }),
    output: z.object({ fiscalYear: z.string(), period: z.number().int() }),
    async run(books, input) {
      const period = indexBooks(await books.describe()).period(input.fiscalYear, input.period);
      settled(await books.transitionPeriod({ periodId: period.id, transition: "reopen" }));
      return { fiscalYear: input.fiscalYear, period: input.period };
    },
  }),
];

export const BOOKS_ACTIONS: AppAction[] = BOOKS_ACTION_LIST.map((action) => action.declaration);

const booksActionsById = new Map(
  BOOKS_ACTION_LIST.map((action) => [action.declaration.id, action]),
);

export function isBooksAction(actionId: string): boolean {
  return booksActionsById.has(actionId);
}

const FIRM_AGENT_KEEPS_NOTHING =
  "A firm's bookkeeping agent reads its clients' books and proposes documents' entries; people change them, in their client's project.";

/**
 * The administration a call keeps the books of, and where it runs: the administration's own
 * project, or the agent project of the firm keeping its books, as Bookkeeping's installation, for
 * an administration of one of the firm's clients.
 */
async function administrationOf(
  env: CloudflareEnv,
  claims: AppActionTokenClaims,
  access: BooksAction["access"],
  named: string | undefined,
): Promise<{ administration: Administration; workplace: Workplace }> {
  const scope = claims.scopeRestriction;
  if (scope.kind !== "project" || scope.owner.kind !== "org") {
    throw new ActionFailure(403, "Books actions run in an administration's Backoffice project.");
  }
  const directory = env.DIRECTORY.getByName("directory");
  const own = await directory.findAdministration({
    clientId: scope.owner.orgId,
    id: scope.projectId,
  });
  if (own) {
    if (named !== undefined && named !== own.id) {
      throw new ActionFailure(
        403,
        "Actions in an administration's project keep its own books: leave out the administration.",
      );
    }
    return { administration: own, workplace: ADMINISTRATION_PROJECT };
  }
  if ((await directory.findFirmAgent(scope.owner.orgId)) !== scope.projectId) {
    throw new ActionFailure(
      403,
      "This Backoffice project is not an administration in Bookkeeping.",
    );
  }
  if (claims.actor.kind !== "installation" || (access !== "read" && access !== "review")) {
    throw new ActionFailure(403, FIRM_AGENT_KEEPS_NOTHING);
  }
  if (named === undefined) {
    throw new ActionFailure(
      400,
      "Name the administration: a firm's bookkeeping agent keeps the books of its clients.",
    );
  }
  const administration = await directory.findFirmAdministration({
    firmId: scope.owner.orgId,
    id: named,
  });
  if (!administration) {
    throw new ActionFailure(403, `The firm keeps the books of no administration ${named}.`);
  }
  return { administration, workplace: firmAgentProject(administration) };
}

/**
 * Answers a document's review, then revokes the document's shares: the firm's agent is done with
 * its file. Should that fail, the document's page revokes them when it shows the answer.
 */
async function answerThenRelease(
  env: CloudflareEnv,
  administration: Administration,
  answer: () => Promise<{ document: string }>,
): Promise<{ document: string }> {
  const answered = await answer();
  try {
    await releaseDocument(env, administration, answered.document);
  } catch (error) {
    console.warn("Bookkeeping could not revoke a reviewed document's shares.", error);
  }
  return answered;
}

/**
 * Runs a books action Backoffice signed, on the books of the administration `administrationOf`
 * finds. Reads are for anyone Backoffice signs for; answering a document's review also for
 * Bookkeeping's installation, which the bookkeeping agent calls as; changing the books is for
 * people whose membership Bookkeeping confirms, and setting them up for owners and admins.
 */
export async function runBooksAction(
  env: CloudflareEnv,
  claims: AppActionTokenClaims,
  actionId: string,
  input: unknown,
): Promise<Response> {
  const action = booksActionsById.get(actionId)!;
  try {
    const { administration: named, ...actionInput } = parse(
      z.looseObject({ administration: administrationInput }),
      input,
    );
    const { administration, workplace } = await administrationOf(env, claims, action.access, named);
    const books = env.BOOKS.getByName(administration.id);
    if (action.access === "read") {
      return Response.json(await action.run(books, actionInput, workplace));
    }
    if (action.access === "review" && claims.actor.kind === "installation") {
      return Response.json(
        await answerThenRelease(env, administration, () =>
          action.run(books, actionInput, { kind: "bookkeeping-agent" }),
        ),
      );
    }
    if (claims.actor.kind !== "user") {
      throw new ActionFailure(
        403,
        "Automations without a person behind them read the books and propose documents' entries; only people change the books.",
      );
    }
    const person = await confirmPerson(env, administration.clientId, claims.actor.userId);
    if (action.access === "set-up" && !canManage(person.roles)) {
      throw new ActionFailure(403, "Only owners and admins set up the books.");
    }
    // Entries and settlements show they were made through Backoffice, e.g. by the person's agent.
    const viaBackoffice = { name: `${person.name} via Backoffice` };
    if (action.access === "review") {
      return Response.json(
        await answerThenRelease(env, administration, () =>
          action.run(books, actionInput, { kind: "person", person: viaBackoffice }),
        ),
      );
    }
    return Response.json(await action.run(books, actionInput, viaBackoffice));
  } catch (error) {
    if (error instanceof ActionFailure) {
      return Response.json({ message: error.message }, { status: error.status });
    }
    if (
      isBackofficeUnavailable(error) ||
      error instanceof BackofficeApiUnreachableError ||
      (error instanceof BackofficeApiRequestError && error.code === null)
    ) {
      return Response.json(
        { message: "Backoffice could not be reached to confirm who you are. Try again shortly." },
        { status: 503 },
      );
    }
    throw error;
  }
}

/**
 * The person Backoffice signed a call for: their name in Bookkeeping and their roles in the
 * organization. A membership Backoffice confirmed within the last minute is trusted, as the pages
 * trust it; otherwise Bookkeeping asks Backoffice again as the person, so roles changed in
 * Backoffice apply to their agents too.
 */
async function confirmPerson(env: CloudflareEnv, organizationId: string, userId: string) {
  const auth = env.AUTH.getByName("auth");
  const directory = env.DIRECTORY.getByName("directory");
  const signInFirst = "Sign in to Bookkeeping once, so it knows who keeps these books.";
  const name = (await auth.findNames([userId]))[userId];
  if (name === undefined) {
    throw new ActionFailure(403, signInFirst);
  }
  const known = await directory.findMembership({ organizationId, userId });
  if (known && Date.now() - known.confirmedAt < MEMBERSHIP_CONFIRMATION_LIFETIME_MS) {
    return { name, roles: known.roles };
  }
  const token = await auth.getBackofficeAccessTokenOf(userId);
  if (token === null) {
    throw new ActionFailure(403, signInFirst);
  }
  const reauthorize =
    "Sign in to Bookkeeping again: Backoffice no longer accepts its authorization for you.";
  switch (token.status) {
    case "backoffice-unavailable":
      throw new ActionFailure(503, "Backoffice could not be reached. Try again shortly.");
    case "reauthorization-required":
      throw new ActionFailure(403, reauthorize);
    case "authorized":
      break;
  }
  const credential = await exchangeForScope(env, {
    oauthAccessToken: token.accessToken,
    scope: { kind: "org", orgId: organizationId, jurisdiction: null },
  });
  if (credential.status === "unauthorized") {
    throw new ActionFailure(403, reauthorize);
  }
  if (credential.status === "refused") {
    await directory.removeMembership({ organizationId, userId });
    throw new ActionFailure(403, "You are no longer a member of this organization.");
  }
  const confirmed = await credential.client.call(
    { kind: "org", orgId: organizationId, jurisdiction: null },
    "org.get",
  );
  const roles = organizationRoleSchema.array().min(1).parse(confirmed.roles);
  await directory.confirmMembership({
    organization: {
      id: confirmed.organization.organizationId,
      slug: confirmed.organization.slug,
      name: confirmed.organization.name,
    },
    roles,
    through: membershipThrough(confirmed.through),
    confirmedAt: Date.now(),
    userId,
  });
  return { name, roles };
}
