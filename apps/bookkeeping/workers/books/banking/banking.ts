import type { FragnoId } from "@fragno-dev/db/schema";

import { defineFragment, instantiate } from "@fragno-dev/core";
import {
  withDatabase,
  type FragnoPublicConfigWithDatabase,
  type TypedUnitOfWork,
} from "@fragno-dev/db";
import type { createLedgerFragment } from "@fragno-dev/ledger";

import type { createProposalsFragment } from "../proposals/proposals";
import type { AgentProposal, ProposalAnswer } from "../proposals/schema";
import { bookingEntry, booksSource, type SourceDocument } from "../sources";
import type { Statement } from "./camt053";
import type { TransactionDetail } from "./detail";
import { bankingSchema, type StatementEnd, type TransactionBooking } from "./schema";

type LedgerServices = ReturnType<typeof createLedgerFragment>["services"];
type ProposalsServices = ReturnType<typeof createProposalsFragment>["services"];
type ProposalAsked = Parameters<ProposalsServices["requestProposals"]>[0]["asked"];
type PostEntryInput = Parameters<LedgerServices["postEntry"]>[0];
type ReverseEntryInput = Parameters<LedgerServices["reverseEntry"]>[0];
type BankingUnitOfWork = TypedUnitOfWork<typeof bankingSchema>;

/** The ledger kind of the source documents that bank transactions are. */
export const BANK_TRANSACTION_SOURCE_KIND = "bank_transaction";

const PAGE_SIZE = 50;

const bankingErrorCodes = [
  "BANK_ACCOUNT_NOT_FOUND",
  "BANK_ACCOUNT_TAKEN",
  "BANK_ACCOUNT_DIMENSIONS",
  "BANK_JOURNAL_NOT_FOUND",
  "STATEMENT_ACCOUNT_MISMATCH",
  "STATEMENT_CHANGED",
  "STATEMENT_UNBALANCED",
  "STATEMENT_OUT_OF_ORDER",
  "STATEMENT_OVERLAP",
  "STATEMENT_GAP",
  "TRANSACTION_NOT_FOUND",
  "TRANSACTION_BOOKED",
  "TRANSACTION_ENTRY_INVALID",
] as const;

export type BankingErrorCode = (typeof bankingErrorCodes)[number];

/** Thrown by services when an operation does not fit the bank's facts; aborts the transaction. */
export class BankingError extends Error {
  readonly code: BankingErrorCode;

  constructor(code: BankingErrorCode, message: string) {
    super(message);
    this.name = "BankingError";
    this.code = code;
  }
}

export type BankAccountView = {
  id: string;
  iban: string;
  name: string;
  currency: string;
  ledgerAccountCode: string;
  journalId: string;
  lastStatement: { endDate: string; closingBalanceMinor: bigint } | null;
};

export type TransactionRow = {
  id: string;
  bookingDate: string;
  amountMinor: bigint;
  detail: TransactionDetail;
};

/** Where a transaction stands: booked while an entry booking it is in effect. */
export type TransactionState = { status: "to-book" } | { status: "booked"; entryId: string };

/** What the bookkeeping agent made of a bank transaction. */
export type TransactionProposal = AgentProposal<TransactionBooking>;

/** A transaction with what the ledger records of it, and the bookkeeping agent's proposal. */
export type DescribedTransaction = TransactionRow & {
  /** The ledger's source document, once an entry recorded it, with every entry recording it. */
  source: SourceDocument | null;
  state: TransactionState;
  proposal: TransactionProposal | null;
};

export type TransactionView = DescribedTransaction & {
  bankAccount: BankAccountView;
  statement: { id: string; reference: string };
};

/** What an import added: its statements, and the IDs of the transactions they brought to book. */
export type ImportResult = { imported: number; skipped: number; transactionIds: string[] };

/** A statement to import, with a hash of what it says. */
export type FingerprintedStatement = Statement & { fingerprint: string };

/** A transaction's state, as the entries recording it say. */
function transactionState(source: SourceDocument | null): TransactionState {
  const entry = bookingEntry(source);
  return entry === null ? { status: "to-book" } : { status: "booked", entryId: entry.id };
}

/** A transaction with what the ledger and the proposals fragment, read for many, record of it. */
export function describedTransaction(
  row: TransactionRow,
  sources: SourceDocument[],
  proposals: { id: string; proposal: AgentProposal<unknown> }[],
): DescribedTransaction {
  const source = sources.find((candidate) => candidate.id === row.id) ?? null;
  // Only answers about a transaction are recorded under its ID, and they propose its booking.
  const proposal = proposals.find((candidate) => candidate.id === row.id)?.proposal ?? null;
  return {
    ...row,
    source,
    state: transactionState(source),
    proposal: proposal as TransactionProposal | null,
  };
}

/** The transaction a request or answer is about, refused unless it is to book. */
function subjectToBook<TTransaction>(
  transaction: TTransaction | null,
  source: SourceDocument | null,
): TTransaction {
  if (!transaction) {
    throw new BankingError("TRANSACTION_NOT_FOUND", "This bank transaction does not exist.");
  }
  if (transactionState(source).status === "booked") {
    throw new BankingError(
      "TRANSACTION_BOOKED",
      "This bank transaction is booked. Reverse its entry first.",
    );
  }
  return transaction;
}

function bankAccountView(row: {
  id: FragnoId;
  iban: string;
  name: string;
  currency: string;
  ledgerAccountCode: string;
  journalId: string;
  lastStatement: StatementEnd | null;
}): BankAccountView {
  return {
    id: row.id.valueOf(),
    iban: row.iban,
    name: row.name,
    currency: row.currency,
    ledgerAccountCode: row.ledgerAccountCode,
    journalId: row.journalId,
    lastStatement:
      row.lastStatement === null
        ? null
        : {
            endDate: row.lastStatement.endDate,
            closingBalanceMinor: BigInt(row.lastStatement.closingBalanceMinor),
          },
  };
}

function transactionRow(row: {
  id: FragnoId;
  bookingDate: string;
  amountMinor: bigint;
  detail: TransactionDetail;
}): TransactionRow {
  return {
    id: row.id.valueOf(),
    bookingDate: row.bookingDate,
    amountMinor: row.amountMinor,
    detail: row.detail,
  };
}

/**
 * The statements of a file to import, oldest first, after `last`, the account's last imported
 * statement: each must add up, start after the one before ends, and open with its closing balance.
 * Statements imported before, `imported` by their bank's ID with their fingerprints, are skipped;
 * one saying something else than when it was imported is refused, as an import cannot be undone.
 */
function planImport(
  account: { iban: string; currency: string; lastStatement: StatementEnd | null },
  statements: FingerprintedStatement[],
  imported: ReadonlyMap<string, string>,
) {
  const ordered = statements
    .filter(
      (statement, position) =>
        statements.findIndex((other) => other.reference === statement.reference) === position,
    )
    .sort((a, b) => a.endDate.localeCompare(b.endDate) || a.startDate.localeCompare(b.startDate));
  let last =
    account.lastStatement === null
      ? null
      : {
          endDate: account.lastStatement.endDate,
          closingBalanceMinor: BigInt(account.lastStatement.closingBalanceMinor),
        };
  const plan: { statement: FingerprintedStatement; openingBalance: boolean }[] = [];
  for (const statement of ordered) {
    const fingerprint = imported.get(statement.reference);
    if (fingerprint !== undefined && fingerprint !== statement.fingerprint) {
      throw new BankingError(
        "STATEMENT_CHANGED",
        `Statement ${statement.reference} says something else than when it was imported.`,
      );
    }
    if (fingerprint !== undefined) {
      continue;
    }
    if (statement.iban !== account.iban || statement.currency !== account.currency) {
      throw new BankingError(
        "STATEMENT_ACCOUNT_MISMATCH",
        `Statement ${statement.reference} is of ${statement.iban} in ${statement.currency}, not of this bank account.`,
      );
    }
    const moved = statement.entries.reduce((total, entry) => total + entry.amountMinor, 0n);
    if (statement.openingBalanceMinor + moved !== statement.closingBalanceMinor) {
      throw new BankingError(
        "STATEMENT_UNBALANCED",
        `Statement ${statement.reference}'s entries do not add up from its opening to its closing balance.`,
      );
    }
    if (last !== null && statement.endDate < last.endDate) {
      throw new BankingError(
        "STATEMENT_OUT_OF_ORDER",
        `Statement ${statement.reference} ends before the last imported statement: import statements oldest first.`,
      );
    }
    // Balances alone do not tell a statement repeating days already imported: movements that add
    // up to nothing open and close it as one continuing the last, and would be imported twice.
    if (last !== null && statement.startDate <= last.endDate) {
      throw new BankingError(
        "STATEMENT_OVERLAP",
        `Statement ${statement.reference} starts on ${statement.startDate}, a day the statements imported before cover: export statements starting after ${last.endDate}, so no movement is imported twice.`,
      );
    }
    if (last !== null && statement.openingBalanceMinor !== last.closingBalanceMinor) {
      throw new BankingError(
        "STATEMENT_GAP",
        `Statement ${statement.reference} does not open with the closing balance of the statement before it: import the statements between them first.`,
      );
    }
    plan.push({ statement, openingBalance: last === null });
    last = { endDate: statement.endDate, closingBalanceMinor: statement.closingBalanceMinor };
  }
  return { plan, last, skipped: ordered.length - plan.length };
}

function recordStatement(
  uow: BankingUnitOfWork,
  account: { id: FragnoId },
  planned: { statement: FingerprintedStatement; openingBalance: boolean },
  importedBy: string,
): string[] {
  const { statement } = planned;
  const statementId = uow.create(
    "statement",
    {
      bankAccountId: account.id,
      reference: statement.reference,
      startDate: statement.startDate,
      endDate: statement.endDate,
      openingBalanceMinor: statement.openingBalanceMinor,
      closingBalanceMinor: statement.closingBalanceMinor,
      fingerprint: statement.fingerprint,
      importedAt: uow.now(),
      importedBy,
    },
    // A concurrent import of the same file imported it: retrying reads it and skips it.
    { retryOnUniqueConflict: () => true },
  );
  const transactions: { bookingDate: string; amountMinor: bigint; detail: TransactionDetail }[] =
    statement.entries.map((entry) => ({
      bookingDate: entry.bookingDate,
      amountMinor: entry.amountMinor,
      detail: {
        type: "entry",
        bankReference: entry.bankReference,
        valueDate: entry.valueDate,
        information: entry.information,
        parts: entry.parts,
      },
    }));
  // The balance before the account's first statement is booked once, like its transactions.
  if (planned.openingBalance && statement.openingBalanceMinor !== 0n) {
    transactions.unshift({
      bookingDate: statement.startDate,
      amountMinor: statement.openingBalanceMinor,
      detail: { type: "opening-balance" },
    });
  }
  return transactions.map((transaction) =>
    uow
      .create("transaction", {
        ...transaction,
        bankAccountId: account.id,
        statementId,
        booked: false,
      })
      .valueOf(),
  );
}

/**
 * The bank accounts of an administration's books and their banks' statements, booked through its
 * ledger in the same transaction, so a bank transaction is booked by the rules of both. The agent
 * proposes how to book only transactions to book.
 */
const bankingFragmentDefinition = defineFragment("banking")
  .extend(withDatabase(bankingSchema))
  .usesService<"ledger", LedgerServices>("ledger")
  .usesService<"proposals", ProposalsServices>("proposals")
  .providesBaseService(({ defineService, serviceDeps }) =>
    defineService({
      /**
       * Adds a bank account with the ledger account it books to, which takes only entries booking
       * its transactions, in the books' currency.
       */
      addBankAccount: function (input: {
        iban: string;
        name: string;
        currency: string;
        ledgerAccountCode: string;
        journalId: string;
      }) {
        return this.serviceTx(bankingSchema)
          .withServiceCalls(
            () =>
              [
                serviceDeps.ledger.createAccount({
                  code: input.ledgerAccountCode,
                  name: input.name,
                  classification: { type: "asset", role: "ordinary" },
                  normalSide: "debit",
                  currency: input.currency,
                  dimensionRules: {},
                  sourceKinds: [BANK_TRANSACTION_SOURCE_KIND],
                }),
                serviceDeps.ledger.listJournals(),
              ] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("bankAccount", (b) =>
              b.whereIndex("idx_bank_account_iban", (eb) => eb("iban", "=", input.iban)),
            ),
          )
          .mutate(
            ({ uow, retrieveResult: [existing], serviceIntermediateResult: [, journals] }) => {
              // The ledger never deletes journals, so one that exists now always will.
              if (!journals.some((journal) => journal.id === input.journalId)) {
                throw new BankingError(
                  "BANK_JOURNAL_NOT_FOUND",
                  "Choose one of the books' journals to book the account's transactions in.",
                );
              }
              if (existing) {
                throw new BankingError(
                  "BANK_ACCOUNT_TAKEN",
                  "The books already have a bank account with this IBAN.",
                );
              }
              const id = uow.create(
                "bankAccount",
                { ...input, lastStatement: null },
                // Another addition of the same IBAN: retrying reads it and refuses.
                { retryOnUniqueConflict: () => true },
              );
              return { id: id.valueOf() };
            },
          )
          .build();
      },

      listBankAccounts: function () {
        return this.serviceTx(bankingSchema)
          .retrieve((uow) =>
            uow.find("bankAccount", (b) =>
              b.whereIndex("idx_bank_account_iban").orderByIndex("idx_bank_account_iban", "asc"),
            ),
          )
          .transformRetrieve(([accounts]) => accounts.map(bankAccountView))
          .build();
      },

      getBankAccount: function (id: string) {
        return this.serviceTx(bankingSchema)
          .retrieve((uow) =>
            uow.findFirst("bankAccount", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id))),
          )
          .transformRetrieve(([account]) => (account ? bankAccountView(account) : null))
          .build();
      },

      /**
       * Imports a file's statements of a bank account, oldest first, each with its transactions,
       * continuing the last statement imported; statements imported before are skipped, so
       * importing a file again imports nothing. The account's first statement also records the
       * balance it opened with, to book once.
       */
      importStatements: function (input: {
        bankAccountId: string;
        statements: FingerprintedStatement[];
        importedBy: string;
      }) {
        const references = input.statements.map((statement) => statement.reference);
        return this.serviceTx(bankingSchema)
          .retrieve((uow) =>
            uow
              .findFirst("bankAccount", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", input.bankAccountId)),
              )
              .find("statement", (b) =>
                b
                  .whereIndex("idx_statement_reference", (eb) =>
                    eb.and(
                      eb("bankAccountId", "=", input.bankAccountId),
                      eb("reference", "in", references),
                    ),
                  )
                  .select(["reference", "fingerprint"]),
              ),
          )
          .mutate(({ uow, retrieveResult: [account, imported] }): ImportResult => {
            if (!account) {
              throw new BankingError("BANK_ACCOUNT_NOT_FOUND", "This bank account does not exist.");
            }
            const { plan, last, skipped } = planImport(
              account,
              input.statements,
              new Map(imported.map((statement) => [statement.reference, statement.fingerprint])),
            );
            const transactionIds = plan.flatMap((planned) =>
              recordStatement(uow, account, planned, input.importedBy),
            );
            if (plan.length > 0 && last !== null) {
              uow.update("bankAccount", account.id, (b) =>
                b
                  .set({
                    lastStatement: {
                      endDate: last.endDate,
                      closingBalanceMinor: last.closingBalanceMinor.toString(),
                    },
                  })
                  .check(),
              );
            }
            return { imported: plan.length, skipped, transactionIds };
          })
          .build();
      },

      /**
       * A page of a bank account's transactions, latest first: those to book, or all of them;
       * without what the ledger records of them.
       */
      listTransactions: function (input: {
        bankAccountId: string;
        toBook: boolean;
        cursor: string | null;
      }) {
        return this.serviceTx(bankingSchema)
          .retrieve((uow) =>
            uow.findWithCursor("transaction", (b) => {
              const page = input.toBook
                ? b
                    .whereIndex("idx_transaction_account_booked_date", (eb) =>
                      eb.and(
                        eb("bankAccountId", "=", input.bankAccountId),
                        eb("booked", "=", false),
                      ),
                    )
                    .orderByIndex("idx_transaction_account_booked_date", "desc")
                    .pageSize(PAGE_SIZE)
                : b
                    .whereIndex("idx_transaction_account_date", (eb) =>
                      eb("bankAccountId", "=", input.bankAccountId),
                    )
                    .orderByIndex("idx_transaction_account_date", "desc")
                    .pageSize(PAGE_SIZE);
              return input.cursor ? page.after(input.cursor) : page;
            }),
          )
          .transformRetrieve(([page]) => ({
            cursor: page.hasNextPage ? (page.cursor?.encode() ?? null) : null,
            items: page.items.map(transactionRow),
          }))
          .build();
      },

      /** The transactions of `ids` that exist, in no particular order. */
      getTransactions: function (ids: string[]) {
        return this.serviceTx(bankingSchema)
          .withServiceCalls(
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids }),
                serviceDeps.proposals.getProposals({ ids }),
              ] as const,
          )
          .retrieve((uow) =>
            uow.find("transaction", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "in", ids))
                .joinOne("bankAccount", "bankAccount", (account) =>
                  account.onIndex("primary", (eb) => eb("id", "=", eb.parent("bankAccountId"))),
                )
                .joinOne("statement", "statement", (statement) =>
                  statement
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("statementId")))
                    .select(["id", "reference"]),
                ),
            ),
          )
          .transformRetrieve(([transactions], [sources, proposals]): TransactionView[] =>
            transactions.map((transaction) => ({
              ...describedTransaction(transactionRow(transaction), sources, proposals),
              // References always resolve: every joined row is referenced by a foreign key.
              bankAccount: bankAccountView(transaction.bankAccount!),
              statement: {
                id: transaction.statement!.id.valueOf(),
                reference: transaction.statement!.reference,
              },
            })),
          )
          .build();
      },

      /**
       * Posts an entry booking a transaction: its first, which creates its source document, or one
       * after every earlier entry was reversed. The entry posts on the transaction's booking date,
       * and on bank accounts only to the transaction's own, by its amount, so the ledger's bank
       * account adds up to the bank's statements. The customers and suppliers it books to are
       * learned as the counterparty's, by its IBAN.
       */
      bookTransaction: function (input: {
        transactionId: string;
        source: { type: "new"; documentDate: string; description: string } | { type: "existing" };
        entry: Omit<PostEntryInput, "source">;
      }) {
        const { transactionId, entry } = input;
        const partyAccountIds = [
          ...new Set(entry.lines.flatMap((line) => line.openItem?.partyAccountId ?? [])),
        ];
        return this.serviceTx(bankingSchema)
          .withServiceCalls(
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids: [transactionId] }),
                serviceDeps.ledger.listAccounts(),
                serviceDeps.proposals.withdrawRequest({
                  subjectId: transactionId,
                  reason: "The bank transaction was booked before the agent answered.",
                }),
                serviceDeps.ledger.postEntry({
                  ...entry,
                  source:
                    input.source.type === "new"
                      ? {
                          ...input.source,
                          type: "new",
                          id: transactionId,
                          kind: BANK_TRANSACTION_SOURCE_KIND,
                        }
                      : { type: "existing", id: transactionId },
                }),
              ] as const,
          )
          .retrieve((uow) =>
            uow
              .findFirst("transaction", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", transactionId)),
              )
              .find("bankAccount", (b) => b.whereIndex("primary"))
              .find("counterparty", (b) =>
                b.whereIndex("idx_counterparty_party", (eb) =>
                  eb("partyAccountId", "in", partyAccountIds),
                ),
              ),
          )
          .mutate(
            ({
              uow,
              retrieveResult: [transaction, bankAccounts, counterparties],
              serviceIntermediateResult: [sources, accounts],
            }) => {
              if (!transaction) {
                throw new BankingError(
                  "TRANSACTION_NOT_FOUND",
                  "This bank transaction does not exist.",
                );
              }
              if (transactionState(sources[0] ?? null).status === "booked") {
                throw new BankingError(
                  "TRANSACTION_BOOKED",
                  "This bank transaction is booked. Reverse its entry first.",
                );
              }
              assertBooksTransaction(entry, transaction, bankAccounts, accounts);
              uow.update("transaction", transaction.id, (b) => b.set({ booked: true }).check());

              // Learned only from a single counterparty: a batch's parties are not each IBAN's.
              const { detail } = transaction;
              const ibans =
                detail.type === "entry" ? [...new Set(detail.parts.map((part) => part.iban))] : [];
              const iban = ibans.length === 1 ? ibans[0] : null;
              if (iban === null) {
                return;
              }
              for (const partyAccountId of partyAccountIds) {
                const known = counterparties.some(
                  (row) => row.iban === iban && row.partyAccountId === partyAccountId,
                );
                if (!known) {
                  // A concurrent booking learned it: retrying reads it.
                  uow.create(
                    "counterparty",
                    { iban, partyAccountId },
                    { retryOnUniqueConflict: () => true },
                  );
                }
              }
            },
          )
          .transform(({ serviceResult: [, , , posted] }) => posted)
          .build();
      },

      /**
       * Reverses an entry recording the transaction. Reversing a reversal books the transaction
       * again, so it is refused like booking: unless the transaction is to book.
       */
      reverseTransactionEntry: function (input: {
        transactionId: string;
        reversal: ReverseEntryInput;
      }) {
        const { transactionId, reversal } = input;
        return this.serviceTx(bankingSchema)
          .withServiceCalls(
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids: [transactionId] }),
                serviceDeps.ledger.reverseEntry(reversal),
              ] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("transaction", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", transactionId)),
            ),
          )
          .mutate(
            ({ uow, retrieveResult: [transaction], serviceIntermediateResult: [sources] }) => {
              const source = sources[0];
              const entry = source?.entries.find((candidate) => candidate.id === reversal.entryId);
              if (!transaction || !entry) {
                throw new BankingError(
                  "TRANSACTION_NOT_FOUND",
                  "This bank transaction does not exist.",
                );
              }
              const booking = booksSource(entry, source);
              if (!booking && transactionState(source).status === "booked") {
                throw new BankingError(
                  "TRANSACTION_BOOKED",
                  "This bank transaction is booked. Reverse its entry first.",
                );
              }
              uow.update("transaction", transaction.id, (b) => b.set({ booked: !booking }).check());
            },
          )
          .transform(({ serviceResult: [, reversed] }) => reversed)
          .build();
      },

      /**
       * Records that the bookkeeping agent was asked about transactions to book, each told to the
       * firm with its prompt, as the proposals fragment records requests. Returns the proposal in
       * effect for each, in order.
       */
      requestProposals: function (input: {
        requests: {
          transactionId: string;
          requestId: string;
          prompt: string;
        }[];
        asked: ProposalAsked;
        first: boolean;
      }) {
        const { requests, asked, first } = input;
        const ids = requests.map((request) => request.transactionId);
        return this.serviceTx(bankingSchema)
          .withServiceCalls(
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids }),
                serviceDeps.proposals.requestProposals({
                  requests: requests.map(({ transactionId, ...request }) => ({
                    subjectId: transactionId,
                    ...request,
                  })),
                  asked,
                  first,
                }),
              ] as const,
          )
          .retrieve((uow) =>
            uow.find("transaction", (b) => b.whereIndex("primary", (eb) => eb("id", "in", ids))),
          )
          .transformRetrieve(([transactions], [sources]) =>
            ids.map((id) =>
              subjectToBook(
                transactions.find((transaction) => transaction.id.valueOf() === id) ?? null,
                sources.find((source) => source.id === id) ?? null,
              ),
            ),
          )
          .mutate(
            ({ uow, retrieveResult: transactions, serviceIntermediateResult: [, { planned }] }) => {
              // Booking a transaction updates it, so a request and a booking conflict whichever
              // commits first: a request after a booking retries and is refused, and a booking after
              // a request retries and withdraws it. A transaction asked about is otherwise as it was.
              transactions.forEach((transaction, index) => {
                if (planned[index]?.recorded) {
                  uow.update("transaction", transaction.id, (b) =>
                    b.set({ booked: transaction.booked }).check(),
                  );
                }
              });
            },
          )
          .transform(({ serviceResult: [, requested] }) =>
            requested.map(({ subjectId, proposal }) => ({
              transactionId: subjectId,
              proposal: proposal as TransactionProposal,
            })),
          )
          .build();
      },

      /** Records an answer to a request about a transaction, as the proposals fragment does. */
      answerRequest: function (input: {
        transactionId: string;
        request: string | null;
        answer: ProposalAnswer<TransactionBooking>;
      }) {
        const { transactionId, request, answer } = input;
        return this.serviceTx(bankingSchema)
          .withServiceCalls(
            () =>
              [
                serviceDeps.ledger.getSourceDocuments({ ids: [transactionId] }),
                serviceDeps.proposals.answerRequest({ subjectId: transactionId, request, answer }),
              ] as const,
          )
          .retrieve((uow) =>
            uow.findFirst("transaction", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", transactionId)),
            ),
          )
          .transformRetrieve(([transaction], [sources]) =>
            subjectToBook(transaction, sources[0] ?? null),
          )
          .transform(() => answer)
          .build();
      },

      /** The customers and suppliers an IBAN paid or was paid by, by party account ID. */
      /** The party accounts each of `ibans` paid or was paid by, as learned from bookings. */
      counterpartiesOf: function (ibans: string[]) {
        return this.serviceTx(bankingSchema)
          .retrieve((uow) =>
            uow.find("counterparty", (b) =>
              b.whereIndex("idx_counterparty_iban", (eb) => eb("iban", "in", ibans)),
            ),
          )
          .transformRetrieve(([rows]) =>
            rows.map((row) => ({ iban: row.iban, partyAccountId: row.partyAccountId })),
          )
          .build();
      },
    }),
  )
  .build();

/**
 * Refuses an entry that does not book `transaction` as it moved its bank account: on its booking
 * date, with its amount on its bank account's ledger account, and nothing on other bank accounts.
 */
function assertBooksTransaction(
  entry: Omit<PostEntryInput, "source">,
  transaction: { bookingDate: string; amountMinor: bigint; bankAccountId: { internalId: bigint } },
  bankAccounts: { id: FragnoId; ledgerAccountCode: string }[],
  accounts: { id: string; code: string }[],
) {
  // Bank accounts' ledger accounts are created with them, so every code resolves.
  const ledgerAccountOf = (code: string) => accounts.find((account) => account.code === code)!;
  const own = bankAccounts.find(
    (account) => account.id.internalId === transaction.bankAccountId.internalId,
  )!;
  const ownLedgerAccount = ledgerAccountOf(own.ledgerAccountCode);
  const bankLedgerAccountIds = new Set(
    bankAccounts.map((account) => ledgerAccountOf(account.ledgerAccountCode).id),
  );
  if (entry.postingDate !== transaction.bookingDate) {
    throw new BankingError(
      "TRANSACTION_ENTRY_INVALID",
      `Book a bank transaction on the date the bank booked it, ${transaction.bookingDate}.`,
    );
  }
  let movedMinor = 0n;
  for (const line of entry.lines) {
    if (!bankLedgerAccountIds.has(line.accountId)) {
      continue;
    }
    if (line.accountId !== ownLedgerAccount.id) {
      throw new BankingError(
        "TRANSACTION_ENTRY_INVALID",
        "A bank transaction is booked on its own bank account only: book transfers between bank accounts through an account in between.",
      );
    }
    movedMinor += line.side === "debit" ? line.amountMinor : -line.amountMinor;
  }
  if (movedMinor !== transaction.amountMinor) {
    throw new BankingError(
      "TRANSACTION_ENTRY_INVALID",
      `Book the transaction's amount on its bank account, ${ownLedgerAccount.code}.`,
    );
  }
}

export function createBankingFragment(
  options: FragnoPublicConfigWithDatabase,
  services: { ledger: LedgerServices; proposals: ProposalsServices },
) {
  return instantiate(bankingFragmentDefinition)
    .withConfig({})
    .withOptions(options)
    .withServices(services)
    .build();
}
