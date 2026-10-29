import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { LedgerError, type LedgerErrorCode } from "@fragno-dev/ledger/errors";
import { DurableObject } from "cloudflare:workers";

import { migrate } from "@fragno-dev/db";
import { createLedgerFragment } from "@fragno-dev/ledger";

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

type Ledger = ReturnType<typeof createLedgerFragment>;
type LedgerServices = Ledger["services"];
type Input<TOperation extends keyof LedgerServices> = Parameters<LedgerServices[TOperation]>[0];
type Documents = ReturnType<typeof createDocumentsFragment>;

/**
 * What a ledger operation produced, or why the ledger refused it. Refusals are values because
 * errors crossing Durable Object RPC keep only their message, and the page must tell a refusal,
 * which it shows, from a failure.
 */
export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: LedgerErrorCode | DocumentErrorCode; message: string };

/**
 * One administration's books: the ledger fragment and the documents booked through it, on the
 * object's own SQLite database, named by the administration's ID.
 */
export class Books extends DurableObject<CloudflareEnv> {
  private readonly ledger: Ledger;
  private readonly documents: Documents;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    // One adapter, so a document is booked in the same transaction as its entry.
    const databaseAdapter = new SqlAdapter({
      dialect: new DurableObjectDialect({ ctx, queryInstrumentation: null }),
      driverConfig: new CloudflareDurableObjectsDriverConfig(),
    });
    this.ledger = createLedgerFragment({ databaseAdapter });
    this.documents = createDocumentsFragment({ databaseAdapter }, { ledger: this.ledger.services });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.ledger);
      await migrate(this.documents);
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
          services.createAccount({ ...account, currency: null, dimensionRules: {} }),
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
    const services = this.ledger.services;
    const [ledger, currencies, fiscalYears, accounts, journals, dimensions, parties] =
      await this.ledger.callServices(() => [
        services.getLedger(),
        services.listCurrencies(),
        services.listFiscalYears(),
        services.listAccounts(),
        services.listJournals(),
        services.listDimensions(),
        services.listParties(),
      ]);
    return { ...ledger, currencies, fiscalYears, accounts, journals, dimensions, parties };
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

  createAccount(input: Input<"createAccount">) {
    return attempt(this.ledger.callServices(() => this.ledger.services.createAccount(input)));
  }

  updateAccount(input: Input<"updateAccount">) {
    return attempt(this.ledger.callServices(() => this.ledger.services.updateAccount(input)));
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
   * Reverses an entry, read with its source document. A document's entries are reversed by the
   * documents' rules too, as reversing a reversal books the document again.
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
    const sources = await this.ledger.callServices(() =>
      this.ledger.services.getSourceDocuments({ ids: page.items.map((document) => document.id) }),
    );
    return {
      cursor: page.cursor,
      items: page.items.map((document) =>
        describeDocument(document, sources.find((source) => source.id === document.id) ?? null),
      ),
    };
  }

  getDocument(id: string) {
    return this.documents.callServices(() => this.documents.services.getDocument(id));
  }

  bookDocument(input: Parameters<Documents["services"]["bookDocument"]>[0]) {
    return attempt(this.documents.callServices(() => this.documents.services.bookDocument(input)));
  }

  requestReview(input: Parameters<Documents["services"]["requestReview"]>[0]) {
    return attempt(this.documents.callServices(() => this.documents.services.requestReview(input)));
  }

  answerReview(input: Parameters<Documents["services"]["answerReview"]>[0]) {
    return attempt(this.documents.callServices(() => this.documents.services.answerReview(input)));
  }

  dismissDocument(input: { documentId: string; dismissedBy: string }) {
    return attempt(
      this.documents.callServices(() => this.documents.services.dismissDocument(input)),
    );
  }
}

async function attempt<T>(operation: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await operation };
  } catch (error) {
    if (error instanceof LedgerError || error instanceof DocumentError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}
