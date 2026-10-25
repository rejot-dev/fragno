import type { DatabaseServiceContext } from "@fragno-dev/db";

import { LedgerError } from "./errors";
import { LEDGER_ID, ledgerSchema, type CalendarDate, type PeriodStatus } from "./schema";

type LedgerServiceContext = DatabaseServiceContext<{}>;

export type OpenLedgerInput = {
  name: string;
  functionalCurrency: { code: string; minorUnitDigits: number };
};

export type OpenFiscalYearInput = {
  name: string;
  startDate: CalendarDate;
  /** Each period ends on its date and starts the day after the previous one; the last ends the year. */
  periodEndDates: CalendarDate[];
};

/** Which status each period operation moves from, and to. */
const periodTransitions = {
  close: { from: "open", to: "closed" },
  reopen: { from: "closed", to: "open" },
  lock: { from: "closed", to: "locked" },
} as const satisfies Record<string, { from: PeriodStatus; to: PeriodStatus }>;

export type PeriodTransition = keyof typeof periodTransitions;

export const calendarServices = {
  /** Opens the ledger, keeping its books in a functional currency it adds if missing. */
  openLedger: function (this: LedgerServiceContext, input: OpenLedgerInput) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow
          .findFirst("ledger", (b) => b.whereIndex("primary", (eb) => eb("id", "=", LEDGER_ID)))
          .findFirst("currency", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.functionalCurrency.code)),
          ),
      )
      .mutate(({ uow, retrieveResult: [ledger, currency] }) => {
        if (ledger) {
          throw new LedgerError("LEDGER_ALREADY_OPEN", "The ledger is already open.");
        }
        const functionalCurrency =
          currency?.id ??
          uow.create("currency", {
            id: input.functionalCurrency.code,
            minorUnitDigits: input.functionalCurrency.minorUnitDigits,
          });
        uow.create("ledger", { id: LEDGER_ID, name: input.name, functionalCurrency });
      })
      .build();
  },

  addCurrency: function (
    this: LedgerServiceContext,
    input: { code: string; minorUnitDigits: number },
  ) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.findFirst("currency", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", input.code)),
        ),
      )
      .mutate(({ uow, retrieveResult: [existing] }) => {
        if (existing) {
          throw new LedgerError("CURRENCY_TAKEN", `Currency ${input.code} already exists.`);
        }
        uow.create("currency", { id: input.code, minorUnitDigits: input.minorUnitDigits });
      })
      .build();
  },

  /**
   * Opens the next fiscal year with its periods. The first year starts on any date; every later
   * year starts the day after the previous one ends.
   */
  openFiscalYear: function (this: LedgerServiceContext, input: OpenFiscalYearInput) {
    const periods = partitionIntoPeriods(input.startDate, input.periodEndDates);
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow
          .findFirst("fiscalYear", (b) =>
            b.whereIndex("idx_fiscal_year_number").orderByIndex("idx_fiscal_year_number", "desc"),
          )
          .findFirst("fiscalYear", (b) =>
            b.whereIndex("idx_fiscal_year_name", (eb) => eb("name", "=", input.name)),
          ),
      )
      .mutate(({ uow, retrieveResult: [previous, sameName] }) => {
        if (sameName) {
          throw new LedgerError(
            "FISCAL_YEAR_NAME_TAKEN",
            `Fiscal year ${input.name} already exists.`,
          );
        }
        if (previous && input.startDate !== nextDay(previous.endDate)) {
          throw new LedgerError(
            "FISCAL_YEAR_NOT_CONTIGUOUS",
            `The next fiscal year must start on ${nextDay(previous.endDate)}.`,
          );
        }
        const fiscalYearId = uow.create("fiscalYear", {
          // Concurrent years claim the same number, so the unique index rejects all but one.
          number: (previous?.number ?? 0) + 1,
          name: input.name,
          startDate: input.startDate,
          endDate: periods[periods.length - 1].endDate,
        });
        const periodIds = periods.map((period, index) =>
          uow.create("period", {
            fiscalYearId,
            number: index + 1,
            startDate: period.startDate,
            endDate: period.endDate,
            status: "open",
          }),
        );
        return { id: fiscalYearId.valueOf(), periodIds: periodIds.map((id) => id.valueOf()) };
      })
      .build();
  },

  /** Closes, reopens, or locks a period. Posting checks the period's version, so it sees the change. */
  transitionPeriod: function (
    this: LedgerServiceContext,
    input: { periodId: string; transition: PeriodTransition },
  ) {
    const { from, to } = periodTransitions[input.transition];
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.findFirst("period", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", input.periodId)),
        ),
      )
      .mutate(({ uow, retrieveResult: [period] }) => {
        if (!period) {
          throw new LedgerError("PERIOD_NOT_FOUND", "The period does not exist.");
        }
        if (period.status !== from) {
          throw new LedgerError(
            "PERIOD_TRANSITION_INVALID",
            `Only ${from} periods can ${input.transition}; this period is ${period.status}.`,
          );
        }
        uow.update("period", period.id, (b) => b.set({ status: to }).check());
      })
      .build();
  },
};

/** The periods a fiscal year's period end dates describe, which must strictly increase. */
function partitionIntoPeriods(
  startDate: CalendarDate,
  periodEndDates: CalendarDate[],
): { startDate: CalendarDate; endDate: CalendarDate }[] {
  let periodStart = startDate;
  return periodEndDates.map((endDate) => {
    if (endDate < periodStart) {
      throw new LedgerError(
        "FISCAL_YEAR_NOT_CONTIGUOUS",
        `A period starting ${periodStart} cannot end on ${endDate}.`,
      );
    }
    const period = { startDate: periodStart, endDate };
    periodStart = nextDay(endDate);
    return period;
  });
}

function nextDay(date: CalendarDate): CalendarDate {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}
