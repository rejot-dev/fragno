import type { DatabaseServiceContext } from "@fragno-dev/db";

import { LedgerError } from "./errors";
import { LEDGER_ID, ledgerSchema } from "./schema";
import type {
  AccountLineView,
  AccountView,
  CurrencyView,
  DimensionView,
  EntryView,
  FiscalYearView,
  JournalView,
  LedgerView,
  OpenItemView,
  Page,
  PartyView,
  SourceDocumentView,
  TrialBalanceRowView,
} from "./views";

type LedgerServiceContext = DatabaseServiceContext<{}>;

const PAGE_SIZE = 50;

export const readServices = {
  getLedger: function (this: LedgerServiceContext) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.findFirst("ledger", (b) =>
          b
            .whereIndex("primary", (eb) => eb("id", "=", LEDGER_ID))
            .joinOne("currency", "currency", (currency) =>
              currency
                .onIndex("primary", (eb) => eb("id", "=", eb.parent("functionalCurrency")))
                .select(["id"]),
            ),
        ),
      )
      .transformRetrieve(([ledger]): LedgerView => {
        if (!ledger?.currency) {
          throw new LedgerError("LEDGER_NOT_OPEN", "The ledger is not open.");
        }
        return { name: ledger.name, functionalCurrency: ledger.currency.id.valueOf() };
      })
      .build();
  },

  listCurrencies: function (this: LedgerServiceContext) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) => uow.find("currency", (b) => b.whereIndex("primary")))
      .transformRetrieve(([currencies]): CurrencyView[] =>
        currencies.map((currency) => ({
          code: currency.id.valueOf(),
          minorUnitDigits: currency.minorUnitDigits,
        })),
      )
      .build();
  },

  listFiscalYears: function (this: LedgerServiceContext) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.find("fiscalYear", (b) =>
          b
            .whereIndex("idx_fiscal_year_number")
            .orderByIndex("idx_fiscal_year_number", "asc")
            .joinMany("periods", "period", (period) =>
              period
                .onIndex("idx_period_year_number", (eb) => eb("fiscalYearId", "=", eb.parent("id")))
                .orderByIndex("idx_period_year_number", "asc"),
            ),
        ),
      )
      .transformRetrieve(([years]): FiscalYearView[] =>
        years.map((year) => ({
          id: year.id.valueOf(),
          number: year.number,
          name: year.name,
          startDate: year.startDate,
          endDate: year.endDate,
          periods: year.periods.map((period) => ({
            id: period.id.valueOf(),
            number: period.number,
            startDate: period.startDate,
            endDate: period.endDate,
            status: period.status,
          })),
        })),
      )
      .build();
  },

  listAccounts: function (this: LedgerServiceContext) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.find("account", (b) =>
          b
            .whereIndex("idx_account_code")
            .orderByIndex("idx_account_code", "asc")
            .joinOne("currencyRow", "currency", (currency) =>
              currency
                .onIndex("primary", (eb) => eb("id", "=", eb.parent("currency")))
                .select(["id"]),
            ),
        ),
      )
      .transformRetrieve(([accounts]): AccountView[] =>
        accounts.map((account) => ({
          id: account.id.valueOf(),
          code: account.code,
          name: account.name,
          type: account.type,
          role: account.role,
          normalSide: account.normalSide,
          currency: account.currencyRow?.id.valueOf() ?? null,
          active: account.active,
          dimensionRules: account.dimensionRules,
        })),
      )
      .build();
  },

  listJournals: function (this: LedgerServiceContext) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.find("journal", (b) =>
          b.whereIndex("idx_journal_code").orderByIndex("idx_journal_code", "asc"),
        ),
      )
      .transformRetrieve(([journals]): JournalView[] =>
        journals.map((journal) => ({
          id: journal.id.valueOf(),
          code: journal.code,
          name: journal.name,
          lastEntryNumber: journal.lastEntryNumber,
        })),
      )
      .build();
  },

  listDimensions: function (this: LedgerServiceContext) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.find("dimension", (b) =>
          b
            .whereIndex("idx_dimension_code")
            .orderByIndex("idx_dimension_code", "asc")
            .joinMany("values", "dimensionValue", (value) =>
              value
                .onIndex("idx_dimension_value_code", (eb) =>
                  eb("dimensionId", "=", eb.parent("id")),
                )
                .orderByIndex("idx_dimension_value_code", "asc"),
            ),
        ),
      )
      .transformRetrieve(([dimensions]): DimensionView[] =>
        dimensions.map((dimension) => ({
          id: dimension.id.valueOf(),
          code: dimension.code,
          name: dimension.name,
          values: dimension.values.map((value) => ({
            id: value.id.valueOf(),
            code: value.code,
            name: value.name,
          })),
        })),
      )
      .build();
  },

  listParties: function (this: LedgerServiceContext) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.find("party", (b) =>
          b
            .whereIndex("primary")
            .joinMany("accounts", "partyAccount", (account) =>
              account
                .onIndex("idx_party_account_party_role", (eb) =>
                  eb("partyId", "=", eb.parent("id")),
                )
                .joinOne("controlAccount", "account", (control) =>
                  control
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("controlAccountId")))
                    .select(["id"]),
                ),
            ),
        ),
      )
      .transformRetrieve(([parties]): PartyView[] =>
        parties.map((party) => ({
          id: party.id.valueOf(),
          name: party.name,
          accounts: party.accounts.map((account) => ({
            id: account.id.valueOf(),
            role: account.role,
            code: account.code,
            // References always resolve: every joined row is referenced by a foreign key.
            controlAccountId: account.controlAccount!.id.valueOf(),
          })),
        })),
      )
      .build();
  },

  /** A journal's entries, newest first, with their lines. */
  listEntries: function (
    this: LedgerServiceContext,
    input: { journalId: string; cursor: string | null },
  ) {
    return readEntries(
      this,
      { journalId: input.journalId, at: { cursor: input.cursor } },
      (page) => page,
    );
  },

  /** One entry of a journal by its number, or null. */
  getEntry: function (
    this: LedgerServiceContext,
    input: { journalId: string; entryNumber: number },
  ) {
    return readEntries(
      this,
      { journalId: input.journalId, at: { entryNumber: input.entryNumber } },
      (page) => page.items[0] ?? null,
    );
  },

  /** An account's lines, latest posting date first. */
  listAccountLines: function (
    this: LedgerServiceContext,
    input: { accountId: string; cursor: string | null },
  ) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.findWithCursor("line", (b) => {
          const page = b
            .whereIndex("idx_line_account_date", (eb) => eb("accountId", "=", input.accountId))
            .orderByIndex("idx_line_account_date", "desc")
            .pageSize(PAGE_SIZE);
          return (input.cursor ? page.after(input.cursor) : page)
            .joinOne("currencyRow", "currency", (currency) =>
              currency
                .onIndex("primary", (eb) => eb("id", "=", eb.parent("currency")))
                .select(["id"]),
            )
            .joinOne("entry", "entry", (entry) =>
              entry
                .onIndex("primary", (eb) => eb("id", "=", eb.parent("entryId")))
                .select(["id", "entryNumber"])
                .joinOne("journal", "journal", (journal) =>
                  journal
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("journalId")))
                    .select(["id"]),
                ),
            );
        }),
      )
      .transformRetrieve(
        ([page]): Page<AccountLineView> => ({
          cursor: page.hasNextPage ? (page.cursor?.encode() ?? null) : null,
          items: page.items.map((line) => {
            // References always resolve: every joined row is referenced by a foreign key.
            const entry = line.entry!;
            return {
              id: line.id.valueOf(),
              entryId: entry.id.valueOf(),
              journalId: entry.journal!.id.valueOf(),
              entryNumber: entry.entryNumber,
              postingDate: line.postingDate,
              side: line.side,
              currency: line.currencyRow!.id.valueOf(),
              amountMinor: line.amountMinor,
              functionalAmountMinor: line.functionalAmountMinor,
              description: line.description,
            };
          }),
        }),
      )
      .build();
  },

  /**
   * A party account's open items by due date, settled ones included, with the entries they come
   * from and the allocations that settled them.
   */
  listOpenItems: function (this: LedgerServiceContext, input: { partyAccountId: string }) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.find("openItem", (b) =>
          b
            .whereIndex("idx_open_item_party_due", (eb) =>
              eb("partyAccountId", "=", input.partyAccountId),
            )
            .orderByIndex("idx_open_item_party_due", "asc")
            .joinOne("line", "line", (line) =>
              line
                .onIndex("primary", (eb) => eb("id", "=", eb.parent("lineId")))
                .select(["id", "amountMinor", "description"])
                .joinOne("entry", "entry", (entry) =>
                  entry
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("entryId")))
                    .select(["id", "entryNumber", "postingDate", "description"])
                    .joinOne("journal", "journal", (journal) =>
                      journal
                        .onIndex("primary", (eb) => eb("id", "=", eb.parent("journalId")))
                        .select(["id"]),
                    ),
                ),
            )
            .joinOne("currencyRow", "currency", (currency) =>
              currency
                .onIndex("primary", (eb) => eb("id", "=", eb.parent("currency")))
                .select(["id"]),
            )
            .joinMany("debitAllocations", "allocation", (allocation) =>
              allocation
                .onIndex("idx_allocation_debit", (eb) => eb("debitItemId", "=", eb.parent("id")))
                .joinOne("reversal", "allocationReversal", (reversal) =>
                  reversal
                    .onIndex("idx_allocation_reversal_allocation", (eb) =>
                      eb("allocationId", "=", eb.parent("id")),
                    )
                    .select(["id"]),
                ),
            )
            .joinMany("creditAllocations", "allocation", (allocation) =>
              allocation
                .onIndex("idx_allocation_credit", (eb) => eb("creditItemId", "=", eb.parent("id")))
                .joinOne("reversal", "allocationReversal", (reversal) =>
                  reversal
                    .onIndex("idx_allocation_reversal_allocation", (eb) =>
                      eb("allocationId", "=", eb.parent("id")),
                    )
                    .select(["id"]),
                ),
            ),
        ),
      )
      .transformRetrieve(([items]): OpenItemView[] => {
        // Allocations pair items of one party account, so both of their items are in this list.
        const itemIds = new Map(items.map((item) => [item.id.internalId!, item.id.valueOf()]));
        return items.map((item) => {
          // References always resolve: every joined row is referenced by a foreign key.
          const line = item.line!;
          const entry = line.entry!;
          return {
            id: item.id.valueOf(),
            lineId: line.id.valueOf(),
            entry: {
              id: entry.id.valueOf(),
              journalId: entry.journal!.id.valueOf(),
              entryNumber: entry.entryNumber,
              postingDate: entry.postingDate,
              description: line.description || entry.description,
            },
            side: item.side,
            currency: item.currencyRow!.id.valueOf(),
            dueDate: item.dueDate,
            amountMinor: line.amountMinor,
            outstandingMinor: item.outstandingMinor,
            allocations: [...item.debitAllocations, ...item.creditAllocations].map(
              (allocation) => ({
                id: allocation.id.valueOf(),
                debitItemId: itemIds.get(allocation.debitItemId.internalId)!,
                creditItemId: itemIds.get(allocation.creditItemId.internalId)!,
                amountMinor: allocation.amountMinor,
                allocatedAt: allocation.allocatedAt,
                allocatedBy: allocation.allocatedBy,
                reversed: allocation.reversal !== null,
              }),
            ),
          };
        });
      })
      .build();
  },

  /**
   * Each account's functional debit and credit totals from the start of a period's fiscal year
   * through that period. Accounts without postings in those periods are left out.
   */
  getTrialBalance: function (this: LedgerServiceContext, input: { periodId: string }) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow
          .findFirst("period", (b) =>
            b
              .whereIndex("primary", (eb) => eb("id", "=", input.periodId))
              .joinOne("fiscalYear", "fiscalYear", (year) =>
                year
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("fiscalYearId")))
                  .joinMany("periods", "period", (period) =>
                    period
                      .onIndex("idx_period_year_number", (eb) =>
                        eb("fiscalYearId", "=", eb.parent("id")),
                      )
                      .joinMany("balances", "balance", (balance) =>
                        balance.onIndex("idx_balance_period_account", (eb) =>
                          eb("periodId", "=", eb.parent("id")),
                        ),
                      ),
                  ),
              ),
          )
          .find("account", (b) =>
            b.whereIndex("idx_account_code").orderByIndex("idx_account_code", "asc"),
          ),
      )
      .transformRetrieve(([period, accounts]): TrialBalanceRowView[] => {
        // The join always finds the fiscal year: periods reference theirs.
        if (!period?.fiscalYear) {
          throw new LedgerError("PERIOD_NOT_FOUND", "The period does not exist.");
        }
        const totals = new Map<bigint, { debitMinor: bigint; creditMinor: bigint }>();
        for (const yearPeriod of period.fiscalYear.periods) {
          if (yearPeriod.number > period.number) {
            continue;
          }
          for (const balance of yearPeriod.balances) {
            const total = totals.get(balance.accountId.internalId) ?? {
              debitMinor: 0n,
              creditMinor: 0n,
            };
            total.debitMinor += balance.debitMinor;
            total.creditMinor += balance.creditMinor;
            totals.set(balance.accountId.internalId, total);
          }
        }
        return accounts.flatMap((account) => {
          // Rows read from the database always carry their internal ID.
          const total = totals.get(account.id.internalId!);
          return total
            ? [
                {
                  accountId: account.id.valueOf(),
                  code: account.code,
                  name: account.name,
                  debitMinor: total.debitMinor,
                  creditMinor: total.creditMinor,
                },
              ]
            : [];
        });
      })
      .build();
  },

  /** The source documents with these IDs that exist, with the entries recording each. */
  getSourceDocuments: function (this: LedgerServiceContext, input: { ids: string[] }) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.find("sourceDocument", (b) =>
          b
            .whereIndex("primary", (eb) => eb("id", "in", input.ids))
            .joinMany("entries", "entry", (entry) =>
              entry
                .onIndex("idx_entry_source", (eb) => eb("sourceDocumentId", "=", eb.parent("id")))
                .select(["id", "entryNumber", "postingDate", "postedAt"])
                .joinOne("journal", "journal", (journal) =>
                  journal
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("journalId")))
                    .select(["id"]),
                )
                .joinOne("reverses", "entry", (reversed) =>
                  reversed
                    .onIndex("primary", (eb) => eb("id", "=", eb.parent("reversesEntryId")))
                    .select(["id"]),
                )
                .joinOne("reversedBy", "entry", (reversal) =>
                  reversal
                    .onIndex("idx_entry_reverses", (eb) =>
                      eb("reversesEntryId", "=", eb.parent("id")),
                    )
                    .select(["id"]),
                ),
            ),
        ),
      )
      .transformRetrieve(([documents]): SourceDocumentView[] =>
        documents.map((document) => ({
          id: document.id.valueOf(),
          kind: document.kind,
          documentDate: document.documentDate,
          description: document.description,
          entries: document.entries
            .toSorted((a, b) => a.postedAt.getTime() - b.postedAt.getTime())
            .map((entry) => ({
              id: entry.id.valueOf(),
              // References always resolve: every joined row is referenced by a foreign key.
              journalId: entry.journal!.id.valueOf(),
              entryNumber: entry.entryNumber,
              postingDate: entry.postingDate,
              reversesEntryId: entry.reverses?.id.valueOf() ?? null,
              reversedByEntryId: entry.reversedBy?.id.valueOf() ?? null,
            })),
        })),
      )
      .build();
  },
};

/**
 * Reads a journal's entries with their lines: a page of them newest first, or the one with a
 * number. `select` picks the result from the page.
 */
function readEntries<T>(
  context: LedgerServiceContext,
  input: {
    journalId: string;
    at: { cursor: string | null } | { entryNumber: number };
  },
  select: (page: Page<EntryView>) => T,
) {
  const { at } = input;
  return context
    .serviceTx(ledgerSchema)
    .retrieve((uow) =>
      uow.findWithCursor("entry", (b) => {
        const page = b
          .whereIndex("idx_entry_journal_number", (eb) =>
            "entryNumber" in at
              ? eb.and(
                  eb("journalId", "=", input.journalId),
                  eb("entryNumber", "=", at.entryNumber),
                )
              : eb("journalId", "=", input.journalId),
          )
          .orderByIndex("idx_entry_journal_number", "desc")
          .pageSize("entryNumber" in at ? 1 : PAGE_SIZE);
        return ("cursor" in at && at.cursor ? page.after(at.cursor) : page)
          .joinOne("period", "period", (period) =>
            period.onIndex("primary", (eb) => eb("id", "=", eb.parent("periodId"))).select(["id"]),
          )
          .joinOne("reverses", "entry", (reversed) =>
            reversed
              .onIndex("primary", (eb) => eb("id", "=", eb.parent("reversesEntryId")))
              .select(["id", "entryNumber"]),
          )
          .joinOne("reversedBy", "entry", (reversal) =>
            reversal
              .onIndex("idx_entry_reverses", (eb) => eb("reversesEntryId", "=", eb.parent("id")))
              .select(["id", "entryNumber"]),
          )
          .joinOne("sourceDocument", "sourceDocument", (document) =>
            document.onIndex("primary", (eb) => eb("id", "=", eb.parent("sourceDocumentId"))),
          )
          .joinMany("lines", "line", (line) =>
            line
              .onIndex("idx_line_entry_number", (eb) => eb("entryId", "=", eb.parent("id")))
              .orderByIndex("idx_line_entry_number", "asc")
              .joinOne("account", "account", (account) =>
                account
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("accountId")))
                  .select(["id"]),
              )
              .joinOne("currencyRow", "currency", (currency) =>
                currency
                  .onIndex("primary", (eb) => eb("id", "=", eb.parent("currency")))
                  .select(["id"]),
              )
              .joinMany("dimensions", "lineDimension", (dimension) =>
                dimension
                  .onIndex("idx_line_dimension_line", (eb) => eb("lineId", "=", eb.parent("id")))
                  .joinOne("value", "dimensionValue", (value) =>
                    value
                      .onIndex("primary", (eb) => eb("id", "=", eb.parent("valueId")))
                      .select(["id"]),
                  ),
              )
              .joinOne("openItem", "openItem", (openItem) =>
                openItem
                  .onIndex("idx_open_item_line", (eb) => eb("lineId", "=", eb.parent("id")))
                  .select(["id"])
                  .joinOne("partyAccount", "partyAccount", (partyAccount) =>
                    partyAccount
                      .onIndex("primary", (eb) => eb("id", "=", eb.parent("partyAccountId")))
                      .select(["id"]),
                  ),
              ),
          );
      }),
    )
    .transformRetrieve(([page]) =>
      select({
        cursor: page.hasNextPage ? (page.cursor?.encode() ?? null) : null,
        items: page.items.map((entry) => {
          // References always resolve: every joined row is referenced by a foreign key.
          const sourceDocument = entry.sourceDocument!;
          return {
            id: entry.id.valueOf(),
            entryNumber: entry.entryNumber,
            postingDate: entry.postingDate,
            periodId: entry.period!.id.valueOf(),
            description: entry.description,
            reference: entry.reference,
            postedAt: entry.postedAt,
            postedBy: entry.postedBy,
            reverses: entry.reverses && {
              id: entry.reverses.id.valueOf(),
              entryNumber: entry.reverses.entryNumber,
            },
            reversedBy: entry.reversedBy && {
              id: entry.reversedBy.id.valueOf(),
              entryNumber: entry.reversedBy.entryNumber,
            },
            sourceDocument: {
              id: sourceDocument.id.valueOf(),
              kind: sourceDocument.kind,
              documentDate: sourceDocument.documentDate,
              description: sourceDocument.description,
            },
            lines: entry.lines.map((line) => ({
              id: line.id.valueOf(),
              number: line.number,
              accountId: line.account!.id.valueOf(),
              side: line.side,
              currency: line.currencyRow!.id.valueOf(),
              amountMinor: line.amountMinor,
              functionalAmountMinor: line.functionalAmountMinor,
              description: line.description,
              dimensionValueIds: line.dimensions.map((dimension) => dimension.value!.id.valueOf()),
              openItem: line.openItem && {
                id: line.openItem.id.valueOf(),
                partyAccountId: line.openItem.partyAccount!.id.valueOf(),
              },
            })),
          };
        }),
      }),
    )
    .build();
}
