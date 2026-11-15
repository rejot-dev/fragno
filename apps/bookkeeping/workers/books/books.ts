import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { LedgerError, type LedgerErrorCode } from "@fragno-dev/ledger/errors";
import { DurableObject } from "cloudflare:workers";

import { migrate } from "@fragno-dev/db";
import { createLedgerFragment } from "@fragno-dev/ledger";

import {
  BANK_TRANSACTION_SOURCE_KIND,
  BankingError,
  createBankingFragment,
  transactionState,
  type BankingErrorCode,
} from "./banking/banking";
import type { Statement } from "./banking/camt053";
import { describeTransaction } from "./banking/detail";
import { FUNCTIONAL_CURRENCIES, type FunctionalCurrency } from "./currencies";
import { DEFAULT_ACCOUNTS, DEFAULT_JOURNALS } from "./default-books";
import {
  createDocumentsFragment,
  describeDocument,
  DOCUMENT_SOURCE_KIND,
  DocumentError,
  type DocumentErrorCode,
  type NewDocument,
} from "./documents/documents";
import { periodEndDates, today } from "./fiscal-years";
import {
  createProposalsFragment,
  ProposalError,
  type ProposalErrorCode,
} from "./proposals/proposals";

type Ledger = ReturnType<typeof createLedgerFragment>;
type LedgerServices = Ledger["services"];
type Input<TOperation extends keyof LedgerServices> = Parameters<LedgerServices[TOperation]>[0];
type Documents = ReturnType<typeof createDocumentsFragment>;
type Banking = ReturnType<typeof createBankingFragment>;
type Proposals = ReturnType<typeof createProposalsFragment>;
type PostingLine = Input<"postEntry">["lines"][number];

/**
 * What a ledger operation produced, or why the ledger refused it. Refusals are values because
 * errors crossing Durable Object RPC keep only their message, and the page must tell a refusal,
 * which it shows, from a failure.
 */
export type Outcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: LedgerErrorCode | DocumentErrorCode | BankingErrorCode | ProposalErrorCode;
      message: string;
    };

/**
 * One administration's books: the ledger fragment, the documents and bank transactions booked
 * through it, and the bookkeeping agent's proposals for booking them, on the object's own SQLite
 * database, named by the administration's ID.
 */
export class Books extends DurableObject<CloudflareEnv> {
  private readonly ledger: Ledger;
  private readonly proposals: Proposals;
  private readonly documents: Documents;
  private readonly banking: Banking;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    // One adapter, so a document or a bank transaction is booked in the same transaction as its
    // entry.
    const databaseAdapter = new SqlAdapter({
      dialect: new DurableObjectDialect({ ctx, queryInstrumentation: null }),
      driverConfig: new CloudflareDurableObjectsDriverConfig(),
    });
    this.ledger = createLedgerFragment({ databaseAdapter });
    this.proposals = createProposalsFragment({ databaseAdapter });
    this.documents = createDocumentsFragment(
      { databaseAdapter },
      { ledger: this.ledger.services, proposals: this.proposals.services },
    );
    this.banking = createBankingFragment({ databaseAdapter }, { ledger: this.ledger.services });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.ledger);
      await migrate(this.proposals);
      await migrate(this.documents);
      await migrate(this.banking);
    });
  }

  /**
   * Opens the books of a new administration, ready to post to: this calendar year in monthly
   * periods, and the default journals and chart of accounts. Opening them again keeps what the
   * first opening set, so creating an administration can be repeated after a failure.
   */
  async open(input: { name: string; functionalCurrency: FunctionalCurrency }): Promise<void> {
    const services = this.ledger.services;
    const year = today().slice(0, 4);
    const startDate = `${year}-01-01`;
    try {
      await this.ledger.callServices(() => [
        services.openLedger({
          name: input.name,
          functionalCurrency: {
            code: input.functionalCurrency,
            minorUnitDigits: FUNCTIONAL_CURRENCIES[input.functionalCurrency],
          },
        }),
        services.openFiscalYear({
          name: year,
          startDate,
          periodEndDates: periodEndDates(startDate, "month"),
        }),
        ...DEFAULT_JOURNALS.map((journal) => services.createJournal(journal)),
        ...DEFAULT_ACCOUNTS.map((account) =>
          services.createAccount({
            ...account,
            currency: null,
            dimensionRules: {},
            sourceKinds: null,
          }),
        ),
      ]);
    } catch (error) {
      // Opening runs in one transaction, so open books are fully set up.
      if (!(error instanceof LedgerError && error.code === "LEDGER_ALREADY_OPEN")) {
        throw error;
      }
    }
  }

  /** Everything the books' pages name and choose from, read together. */
  async describe() {
    return (await this.describeWithTrialBalances([])).described;
  }

  /**
   * The books as `describe` gives them, with the trial balance through each of `periodIds`, all
   * read in one transaction: a report that adds up several balances sees the books at one moment,
   * never with an entry posted between two of its reads.
   */
  async describeWithTrialBalances(periodIds: readonly string[]) {
    const services = this.ledger.services;
    const [ledger, currencies, fiscalYears, accounts, journals, dimensions, parties, ...balances] =
      await this.ledger.callServices(() => [
        services.getLedger(),
        services.listCurrencies(),
        services.listFiscalYears(),
        services.listAccounts(),
        services.listJournals(),
        services.listDimensions(),
        services.listParties(),
        ...periodIds.map((periodId) => services.getTrialBalance({ periodId })),
      ]);
    return {
      described: { ...ledger, currencies, fiscalYears, accounts, journals, dimensions, parties },
      trialBalances: new Map(periodIds.map((periodId, position) => [periodId, balances[position]])),
    };
  }

  listEntries(input: Input<"listEntries">) {
    return this.ledger.callServices(() => this.ledger.services.listEntries(input));
  }

  getEntry(input: Input<"getEntry">) {
    return this.ledger.callServices(() => this.ledger.services.getEntry(input));
  }

  listAccountLines(input: Input<"listAccountLines">) {
    return this.ledger.callServices(() => this.ledger.services.listAccountLines(input));
  }

  listOpenItems(input: Input<"listOpenItems">) {
    return this.ledger.callServices(() => this.ledger.services.listOpenItems(input));
  }

  getTrialBalance(input: Input<"getTrialBalance">) {
    return this.ledger.callServices(() => this.ledger.services.getTrialBalance(input));
  }

  addCurrency(input: Input<"addCurrency">) {
    return attempt(this.ledger.callServices(() => this.ledger.services.addCurrency(input)));
  }

  openFiscalYear(input: Input<"openFiscalYear">) {
    return attempt(this.ledger.callServices(() => this.ledger.services.openFiscalYear(input)));
  }

  transitionPeriod(input: Input<"transitionPeriod">) {
    return attempt(this.ledger.callServices(() => this.ledger.services.transitionPeriod(input)));
  }

  /** Creates an account any entry posts to; bank accounts' own come with them. */
  createAccount(input: Omit<Input<"createAccount">, "sourceKinds">) {
    return attempt(
      this.ledger.callServices(() =>
        this.ledger.services.createAccount({ ...input, sourceKinds: null }),
      ),
    );
  }

  /**
   * Renames an account, (de)activates it, or changes its dimension rules. A bank account's takes
   * none: its line comes from the bank, which names no dimension values.
   */
  async updateAccount(input: Input<"updateAccount">) {
    const accounts = await this.ledger.callServices(() => this.ledger.services.listAccounts());
    // Only bank accounts take entries of some source documents only, which never changes.
    const bank = accounts.find((account) => account.id === input.accountId)?.sourceKinds;
    if (bank && Object.keys(input.dimensionRules).length > 0) {
      return refused(
        "BANK_ACCOUNT_DIMENSIONS",
        "A bank account's lines come from its bank, which gives them no dimension values: its account takes no dimension rules.",
      );
    }
    return await attempt(this.ledger.callServices(() => this.ledger.services.updateAccount(input)));
  }

  createJournal(input: Input<"createJournal">) {
    return attempt(this.ledger.callServices(() => this.ledger.services.createJournal(input)));
  }

  createDimension(input: Input<"createDimension">) {
    return attempt(this.ledger.callServices(() => this.ledger.services.createDimension(input)));
  }

  createDimensionValue(input: Input<"createDimensionValue">) {
    return attempt(
      this.ledger.callServices(() => this.ledger.services.createDimensionValue(input)),
    );
  }

  createPartyAccount(input: Input<"createPartyAccount">) {
    return attempt(this.ledger.callServices(() => this.ledger.services.createPartyAccount(input)));
  }

  postEntry(input: Input<"postEntry">) {
    return attempt(this.ledger.callServices(() => this.ledger.services.postEntry(input)));
  }

  /**
   * Reverses an entry, read with its source document. A document's and a bank transaction's
   * entries are reversed by their rules too, as reversing a reversal books them again.
   */
  reverseEntry(input: Input<"reverseEntry"> & { sourceDocument: { id: string; kind: string } }) {
    const { sourceDocument, ...reversal } = input;
    if (sourceDocument.kind === DOCUMENT_SOURCE_KIND) {
      return attempt(
        this.documents.callServices(() =>
          this.documents.services.reverseDocumentEntry({ documentId: sourceDocument.id, reversal }),
        ),
      );
    }
    if (sourceDocument.kind === BANK_TRANSACTION_SOURCE_KIND) {
      return attempt(
        this.banking.callServices(() =>
          this.banking.services.reverseTransactionEntry({
            transactionId: sourceDocument.id,
            reversal,
          }),
        ),
      );
    }
    return attempt(this.ledger.callServices(() => this.ledger.services.reverseEntry(reversal)));
  }

  allocate(input: Input<"allocate">) {
    return attempt(this.ledger.callServices(() => this.ledger.services.allocate(input)));
  }

  reverseAllocation(input: Input<"reverseAllocation">) {
    return attempt(this.ledger.callServices(() => this.ledger.services.reverseAllocation(input)));
  }

  recordDocument(document: NewDocument) {
    return attempt(
      this.documents.callServices(() => this.documents.services.recordDocument(document)),
    );
  }

  /** A page of documents, newest first, with what the ledger records of each. */
  async listDocuments(input: { cursor: string | null }) {
    const page = await this.documents.callServices(() =>
      this.documents.services.listDocuments(input),
    );
    const ids = page.items.map((document) => document.id);
    const [sources, proposals] = await this.ledger.callServices(() => [
      this.ledger.services.getSourceDocuments({ ids }),
      this.proposals.services.getProposals({ ids }),
    ]);
    return {
      cursor: page.cursor,
      items: page.items.map((document) =>
        describeDocument(
          document,
          sources.find((source) => source.id === document.id) ?? null,
          proposals,
        ),
      ),
    };
  }

  getDocument(id: string) {
    return this.documents.callServices(() => this.documents.services.getDocument(id));
  }

  bookDocument(input: Parameters<Documents["services"]["bookDocument"]>[0]) {
    return attempt(this.documents.callServices(() => this.documents.services.bookDocument(input)));
  }

  requestDocumentProposal(input: Parameters<Documents["services"]["requestProposal"]>[0]) {
    return attempt(
      this.documents.callServices(() => this.documents.services.requestProposal(input)),
    );
  }

  answerDocumentRequest(input: Parameters<Documents["services"]["answerRequest"]>[0]) {
    return attempt(this.documents.callServices(() => this.documents.services.answerRequest(input)));
  }

  recordSharesRevoked(input: { documentId: string }) {
    return attempt(
      this.documents.callServices(() => this.documents.services.recordSharesRevoked(input)),
    );
  }

  /**
   * Withdraws the requests asked before the client's management reached `generation`, as the
   * proposals fragment withdraws them. Returns the IDs of the documents whose files may still be
   * shared, read with the withdrawal: a request records its file shared, and nothing records it
   * unshared while it awaits.
   */
  withdrawRequests(input: { reason: string; generation: number }) {
    return attempt(
      this.documents
        .callServices(
          () =>
            [
              this.proposals.services.withdrawRequests(input),
              this.documents.services.listSharedDocuments(),
            ] as const,
        )
        .then(([, shared]) => shared),
    );
  }

  recordShared(input: { documentId: string; requestId: string }) {
    return attempt(this.documents.callServices(() => this.documents.services.recordShared(input)));
  }

  dismissDocument(input: { documentId: string; dismissedBy: string }) {
    return attempt(
      this.documents.callServices(() => this.documents.services.dismissDocument(input)),
    );
  }

  /**
   * Adds a bank account in the books' currency, with the ledger account of `ledgerAccountCode`
   * that books it.
   */
  async addBankAccount(input: {
    iban: string;
    name: string;
    ledgerAccountCode: string;
    journalId: string;
  }) {
    const { functionalCurrency } = await this.ledger.callServices(() =>
      this.ledger.services.getLedger(),
    );
    return await attempt(
      this.banking.callServices(() =>
        this.banking.services.addBankAccount({ ...input, currency: functionalCurrency }),
      ),
    );
  }

  listBankAccounts() {
    return this.banking.callServices(() => this.banking.services.listBankAccounts());
  }

  getBankAccount(id: string) {
    return this.banking.callServices(() => this.banking.services.getBankAccount(id));
  }

  /** Imports statements of a bank account, each with a hash of what it says. */
  async importStatements(input: {
    bankAccountId: string;
    statements: Statement[];
    importedBy: string;
  }) {
    const statements = await Promise.all(
      input.statements.map(async (statement) => ({
        ...statement,
        fingerprint: await fingerprint(statement),
      })),
    );
    return await attempt(
      this.banking.callServices(() =>
        this.banking.services.importStatements({ ...input, statements }),
      ),
    );
  }

  /** A page of a bank account's transactions, latest first, with what the ledger records of each. */
  async listTransactions(input: { bankAccountId: string; toBook: boolean; cursor: string | null }) {
    const page = await this.banking.callServices(() =>
      this.banking.services.listTransactions(input),
    );
    const sources = await this.ledger.callServices(() =>
      this.ledger.services.getSourceDocuments({ ids: page.items.map((item) => item.id) }),
    );
    return {
      cursor: page.cursor,
      items: page.items.map((transaction) => {
        const source = sources.find((row) => row.id === transaction.id) ?? null;
        return { ...transaction, source, state: transactionState(source) };
      }),
    };
  }

  getTransaction(id: string) {
    return this.banking.callServices(() => this.banking.services.getTransaction(id));
  }

  /**
   * Books a bank transaction with `lines`, the entry's lines besides its bank account's: this adds
   * the line of the transaction's amount on its bank account, on the date the bank booked it.
   */
  async bookTransaction(input: {
    transactionId: string;
    journalId: string;
    description: string;
    reference: string | null;
    postedBy: string;
    lines: PostingLine[];
  }) {
    const { transactionId, lines, ...entry } = input;
    const [transaction, accounts] = await Promise.all([
      this.getTransaction(transactionId),
      this.ledger.callServices(() => this.ledger.services.listAccounts()),
    ]);
    if (transaction === null) {
      return refused("TRANSACTION_NOT_FOUND", "This bank transaction does not exist.");
    }
    const { bankAccount, amountMinor } = transaction;
    // A bank account's ledger account is created with it.
    const ledgerAccount = accounts.find((row) => row.code === bankAccount.ledgerAccountCode)!;
    const bankLine: PostingLine = {
      accountId: ledgerAccount.id,
      side: amountMinor > 0n ? "debit" : "credit",
      currency: bankAccount.currency,
      amountMinor: amountMinor > 0n ? amountMinor : -amountMinor,
      functionalAmountMinor: amountMinor > 0n ? amountMinor : -amountMinor,
      description: "",
      dimensionValueIds: [],
      openItem: null,
    };
    return await attempt(
      this.banking.callServices(() =>
        this.banking.services.bookTransaction({
          transactionId,
          source:
            transaction.source === null
              ? {
                  type: "new",
                  documentDate: transaction.bookingDate,
                  description: describeTransaction(transaction.detail),
                }
              : { type: "existing" },
          entry: { ...entry, postingDate: transaction.bookingDate, lines: [bankLine, ...lines] },
        }),
      ),
    );
  }

  counterpartiesOf(iban: string) {
    return this.banking.callServices(() => this.banking.services.counterpartiesOf(iban));
  }
}

/** The SHA-256 of a statement as read, in hex: the parser reads every field in a fixed order. */
async function fingerprint(statement: Statement): Promise<string> {
  const text = JSON.stringify(statement, (_, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function refused(code: BankingErrorCode, message: string): Outcome<never> {
  return { ok: false, code, message };
}

async function attempt<T>(operation: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await operation };
  } catch (error) {
    if (error instanceof LedgerError && error.code === "ACCOUNT_SOURCE_REFUSED") {
      // Only bank accounts take entries of some source documents only.
      return {
        ok: false,
        code: error.code,
        message:
          "Bank accounts take only the entries booking their bank transactions: book what is owed here, and its payment from the bank transaction.",
      };
    }
    if (
      error instanceof LedgerError ||
      error instanceof DocumentError ||
      error instanceof BankingError ||
      error instanceof ProposalError
    ) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}
