import { z } from "zod";

import { defineRoutes, type FragnoRouteConfig } from "@fragno-dev/core";

import type { PeriodTransition } from "./calendar";
import { ledgerFragmentDefinition } from "./definition";
import { LedgerError, ledgerErrorCodes, type LedgerErrorCode } from "./errors";
import { dimensionRequirements, partyRoles, sides } from "./schema";
import {
  accountView,
  currencyView,
  dimensionView,
  fiscalYearView,
  httpViews,
  journalView,
  ledgerView,
  pageView,
  partyView,
  toHttp,
} from "./views";

const calendarDate = z.iso.date();
const code = z.string().min(1);
const name = z.string().min(1);
const actor = z.string().min(1);
// Strings of digits, as JSON numbers are exact only to 2^53; the services check the range.
const minorUnits = z.string().regex(/^\d+$/u);
const currencyInput = z.object({
  code: z.string().regex(/^[A-Z]{3}$/),
  minorUnitDigits: z.number().int().min(0).max(6),
});
const dimensionRules = z.record(z.string(), z.enum(dimensionRequirements));
const created = z.object({ id: z.string() });

const accountClassification = z.union([
  z.object({ type: z.literal("asset"), role: z.enum(["ordinary", "receivable"]) }),
  z.object({ type: z.literal("liability"), role: z.enum(["ordinary", "payable"]) }),
  z.object({ type: z.enum(["equity", "revenue", "expense"]), role: z.literal("ordinary") }),
]);

const postingLine = z.object({
  accountId: z.string(),
  side: z.enum(sides),
  currency: z.string(),
  amountMinor: minorUnits,
  functionalAmountMinor: minorUnits,
  description: z.string(),
  dimensionValueIds: z.array(z.string()),
  openItem: z.object({ partyAccountId: z.string(), dueDate: calendarDate }).nullable(),
});

const postedEntry = z.object({
  id: z.string(),
  entryNumber: z.number(),
  lineIds: z.array(z.string()),
});

const periodTransitions: PeriodTransition[] = ["close", "reopen", "lock"];

type LedgerRouteError = Parameters<
  FragnoRouteConfig<"GET", "/__error", undefined, undefined, LedgerErrorCode>["handler"]
>[1]["error"];

/** Answers a ledger rule's refusal with its error code; anything else is a failure. */
function refuse(cause: unknown, error: LedgerRouteError): Response {
  if (!(cause instanceof LedgerError)) {
    throw cause;
  }
  return error({ code: cause.code, message: cause.message }, cause.status);
}

export const ledgerRoutesFactory = defineRoutes(ledgerFragmentDefinition).create(
  ({ defineRoute, services }) => [
    defineRoute({
      method: "POST",
      path: "/ledger",
      inputSchema: z.object({ name, functionalCurrency: currencyInput }),
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input }, { empty, error }) {
        const body = await input.valid();
        try {
          await this.handlerTx()
            .withServiceCalls(() => [services.openLedger(body)])
            .execute();
          return empty();
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "GET",
      path: "/ledger",
      outputSchema: ledgerView,
      errorCodes: ledgerErrorCodes,
      handler: async function (_, { json, error }) {
        try {
          const [ledger] = await this.handlerTx()
            .withServiceCalls(() => [services.getLedger()])
            .execute();
          return json(ledger);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "POST",
      path: "/currencies",
      inputSchema: currencyInput,
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input }, { empty, error }) {
        const body = await input.valid();
        try {
          await this.handlerTx()
            .withServiceCalls(() => [services.addCurrency(body)])
            .execute();
          return empty();
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "GET",
      path: "/currencies",
      outputSchema: z.array(currencyView),
      handler: async function (_, { json }) {
        const [currencies] = await this.handlerTx()
          .withServiceCalls(() => [services.listCurrencies()])
          .execute();
        return json(currencies);
      },
    }),

    defineRoute({
      method: "POST",
      path: "/fiscal-years",
      inputSchema: z.object({
        name,
        startDate: calendarDate,
        periodEndDates: z.array(calendarDate).min(1),
      }),
      outputSchema: z.object({ id: z.string(), periodIds: z.array(z.string()) }),
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input }, { json, error }) {
        const body = await input.valid();
        try {
          const [fiscalYear] = await this.handlerTx()
            .withServiceCalls(() => [services.openFiscalYear(body)])
            .execute();
          return json(fiscalYear, 201);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "GET",
      path: "/fiscal-years",
      outputSchema: z.array(fiscalYearView),
      handler: async function (_, { json }) {
        const [fiscalYears] = await this.handlerTx()
          .withServiceCalls(() => [services.listFiscalYears()])
          .execute();
        return json(fiscalYears);
      },
    }),

    defineRoute({
      method: "GET",
      path: "/periods/:periodId/trial-balance",
      outputSchema: z.array(httpViews.trialBalanceRowView),
      errorCodes: ledgerErrorCodes,
      handler: async function ({ pathParams }, { json, error }) {
        try {
          const [rows] = await this.handlerTx()
            .withServiceCalls(() => [services.getTrialBalance({ periodId: pathParams.periodId })])
            .execute();
          return json(toHttp(rows));
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    ...periodTransitions.map((transition) =>
      defineRoute({
        method: "POST",
        path: `/periods/:periodId/${transition}`,
        errorCodes: ledgerErrorCodes,
        handler: async function ({ pathParams }, { empty, error }) {
          try {
            await this.handlerTx()
              .withServiceCalls(() => [
                services.transitionPeriod({ periodId: pathParams.periodId, transition }),
              ])
              .execute();
            return empty(204);
          } catch (cause) {
            return refuse(cause, error);
          }
        },
      }),
    ),

    defineRoute({
      method: "POST",
      path: "/accounts",
      inputSchema: z.object({
        code,
        name,
        classification: accountClassification,
        normalSide: z.enum(sides),
        currency: z.string().nullable(),
        dimensionRules,
      }),
      outputSchema: created,
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input }, { json, error }) {
        const body = await input.valid();
        try {
          const [account] = await this.handlerTx()
            .withServiceCalls(() => [services.createAccount(body)])
            .execute();
          return json(account, 201);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "PUT",
      path: "/accounts/:accountId",
      inputSchema: z.object({ name, active: z.boolean(), dimensionRules }),
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input, pathParams }, { empty, error }) {
        const body = await input.valid();
        try {
          await this.handlerTx()
            .withServiceCalls(() => [
              services.updateAccount({ accountId: pathParams.accountId, ...body }),
            ])
            .execute();
          return empty(204);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "GET",
      path: "/accounts",
      outputSchema: z.array(accountView),
      handler: async function (_, { json }) {
        const [accounts] = await this.handlerTx()
          .withServiceCalls(() => [services.listAccounts()])
          .execute();
        return json(accounts);
      },
    }),

    defineRoute({
      method: "GET",
      path: "/accounts/:accountId/lines",
      queryParameters: ["cursor"],
      outputSchema: pageView(httpViews.accountLineView),
      handler: async function ({ pathParams, query }, { json }) {
        const [page] = await this.handlerTx()
          .withServiceCalls(() => [
            services.listAccountLines({
              accountId: pathParams.accountId,
              cursor: query.get("cursor"),
            }),
          ])
          .execute();
        return json(toHttp(page));
      },
    }),

    defineRoute({
      method: "POST",
      path: "/journals",
      inputSchema: z.object({ code, name }),
      outputSchema: created,
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input }, { json, error }) {
        const body = await input.valid();
        try {
          const [journal] = await this.handlerTx()
            .withServiceCalls(() => [services.createJournal(body)])
            .execute();
          return json(journal, 201);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "GET",
      path: "/journals",
      outputSchema: z.array(journalView),
      handler: async function (_, { json }) {
        const [journals] = await this.handlerTx()
          .withServiceCalls(() => [services.listJournals()])
          .execute();
        return json(journals);
      },
    }),

    defineRoute({
      method: "GET",
      path: "/journals/:journalId/entries",
      queryParameters: ["cursor"],
      outputSchema: pageView(httpViews.entryView),
      handler: async function ({ pathParams, query }, { json }) {
        const [page] = await this.handlerTx()
          .withServiceCalls(() => [
            services.listEntries({ journalId: pathParams.journalId, cursor: query.get("cursor") }),
          ])
          .execute();
        return json(toHttp(page));
      },
    }),

    defineRoute({
      method: "GET",
      path: "/journals/:journalId/entries/:entryNumber",
      outputSchema: httpViews.entryView,
      errorCodes: ledgerErrorCodes,
      handler: async function ({ pathParams }, { json, error }) {
        const entryNumber = Number(pathParams.entryNumber);
        const notFound = () =>
          refuse(new LedgerError("ENTRY_NOT_FOUND", "The entry does not exist."), error);
        if (!Number.isSafeInteger(entryNumber)) {
          return notFound();
        }
        const [entry] = await this.handlerTx()
          .withServiceCalls(() => [
            services.getEntry({ journalId: pathParams.journalId, entryNumber }),
          ])
          .execute();
        return entry ? json(toHttp(entry)) : notFound();
      },
    }),

    defineRoute({
      method: "POST",
      path: "/dimensions",
      inputSchema: z.object({ code, name }),
      outputSchema: created,
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input }, { json, error }) {
        const body = await input.valid();
        try {
          const [dimension] = await this.handlerTx()
            .withServiceCalls(() => [services.createDimension(body)])
            .execute();
          return json(dimension, 201);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "GET",
      path: "/dimensions",
      outputSchema: z.array(dimensionView),
      handler: async function (_, { json }) {
        const [dimensions] = await this.handlerTx()
          .withServiceCalls(() => [services.listDimensions()])
          .execute();
        return json(dimensions);
      },
    }),

    defineRoute({
      method: "POST",
      path: "/dimensions/:dimensionId/values",
      inputSchema: z.object({ code, name }),
      outputSchema: created,
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input, pathParams }, { json, error }) {
        const body = await input.valid();
        try {
          const [value] = await this.handlerTx()
            .withServiceCalls(() => [
              services.createDimensionValue({ dimensionId: pathParams.dimensionId, ...body }),
            ])
            .execute();
          return json(value, 201);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "GET",
      path: "/parties",
      outputSchema: z.array(partyView),
      handler: async function (_, { json }) {
        const [parties] = await this.handlerTx()
          .withServiceCalls(() => [services.listParties()])
          .execute();
        return json(parties);
      },
    }),

    defineRoute({
      method: "POST",
      path: "/party-accounts",
      inputSchema: z.object({
        party: z.union([z.object({ id: z.string() }), z.object({ name })]),
        role: z.enum(partyRoles),
        code,
        controlAccountId: z.string(),
      }),
      outputSchema: z.object({ id: z.string(), partyId: z.string() }),
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input }, { json, error }) {
        const body = await input.valid();
        try {
          const [partyAccount] = await this.handlerTx()
            .withServiceCalls(() => [services.createPartyAccount(body)])
            .execute();
          return json(partyAccount, 201);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "GET",
      path: "/party-accounts/:partyAccountId/open-items",
      outputSchema: z.array(httpViews.openItemView),
      handler: async function ({ pathParams }, { json }) {
        const [items] = await this.handlerTx()
          .withServiceCalls(() => [
            services.listOpenItems({ partyAccountId: pathParams.partyAccountId }),
          ])
          .execute();
        return json(toHttp(items));
      },
    }),

    defineRoute({
      method: "POST",
      path: "/entries",
      inputSchema: z.object({
        journalId: z.string(),
        postingDate: calendarDate,
        description: z.string(),
        reference: z.string().min(1).nullable(),
        postedBy: actor,
        source: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("new"),
            id: z.string().min(1),
            kind: code,
            documentDate: calendarDate,
            description: z.string(),
          }),
          z.object({ type: z.literal("existing"), id: z.string().min(1) }),
        ]),
        lines: z.array(postingLine).min(2),
      }),
      outputSchema: postedEntry,
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input }, { json, error }) {
        const body = await input.valid();
        const lines = body.lines.map((line) => ({
          ...line,
          amountMinor: BigInt(line.amountMinor),
          functionalAmountMinor: BigInt(line.functionalAmountMinor),
        }));
        try {
          const [entry] = await this.handlerTx()
            .withServiceCalls(() => [services.postEntry({ ...body, lines })])
            .execute();
          return json(entry, 201);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "POST",
      path: "/entries/:entryId/reversal",
      inputSchema: z.object({
        postingDate: calendarDate,
        description: z.string(),
        postedBy: actor,
      }),
      outputSchema: postedEntry,
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input, pathParams }, { json, error }) {
        const body = await input.valid();
        try {
          const [entry] = await this.handlerTx()
            .withServiceCalls(() => [
              services.reverseEntry({ entryId: pathParams.entryId, ...body }),
            ])
            .execute();
          return json(entry, 201);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "POST",
      path: "/allocations",
      inputSchema: z.object({
        debitItemId: z.string(),
        creditItemId: z.string(),
        amountMinor: minorUnits.nullable(),
        allocatedBy: actor,
      }),
      outputSchema: z.object({ id: z.string(), amountMinor: minorUnits }),
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input }, { json, error }) {
        const body = await input.valid();
        try {
          const [allocation] = await this.handlerTx()
            .withServiceCalls(() => [
              services.allocate({
                ...body,
                amountMinor: body.amountMinor === null ? null : BigInt(body.amountMinor),
              }),
            ])
            .execute();
          return json(toHttp(allocation), 201);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),

    defineRoute({
      method: "POST",
      path: "/allocations/:allocationId/reversal",
      inputSchema: z.object({ reversedBy: actor }),
      outputSchema: created,
      errorCodes: ledgerErrorCodes,
      handler: async function ({ input, pathParams }, { json, error }) {
        const body = await input.valid();
        try {
          const [reversal] = await this.handlerTx()
            .withServiceCalls(() => [
              services.reverseAllocation({ allocationId: pathParams.allocationId, ...body }),
            ])
            .execute();
          return json(reversal, 201);
        } catch (cause) {
          return refuse(cause, error);
        }
      },
    }),
  ],
);
