import { describe, expect, test } from "vitest";

import { credit, debit, ledgerScenario } from "./ledger.test-support";

const sale = [debit("ar", 100n, { party: "alice-c" }), credit("revenue", 100n)];

describe("calendar", () => {
  test("postings need an open period; closed periods reopen until they are locked", () =>
    ledgerScenario(async (ledger) => {
      await ledger.transitionPeriod("p2", "close");
      await ledger.refuses(
        () => ledger.post({ name: "x", journal: "sales", date: "2026-02-10", lines: sale }),
        "POSTING_PERIOD_NOT_OPEN",
      );
      await ledger.transitionPeriod("p2", "reopen");
      await ledger.post({ name: "e1", journal: "sales", date: "2026-02-10", lines: sale });
      await ledger.refuses(
        () => ledger.transitionPeriod("p2", "lock"),
        "PERIOD_TRANSITION_INVALID",
      );
      await ledger.transitionPeriod("p2", "close");
      await ledger.transitionPeriod("p2", "lock");
      await ledger.refuses(
        () => ledger.transitionPeriod("p2", "reopen"),
        "PERIOD_TRANSITION_INVALID",
      );
      await ledger.refuses(
        () => ledger.post({ name: "x", journal: "sales", date: "2027-01-05", lines: sale }),
        "POSTING_PERIOD_NOT_OPEN",
      );

      const [year] = await ledger.fiscalYears();
      expect(year.periods.slice(0, 3).map((period) => period.status)).toEqual([
        "open",
        "locked",
        "open",
      ]);
    }));

  test("fiscal years follow each other without gaps, and balances restart each year", () =>
    ledgerScenario(async (ledger) => {
      await ledger.refuses(
        () =>
          ledger.openFiscalYear({
            name: "2027",
            startDate: "2027-01-02",
            periodEndDates: ["2027-12-31"],
          }),
        "FISCAL_YEAR_NOT_CONTIGUOUS",
      );
      await ledger.refuses(
        () =>
          ledger.openFiscalYear({
            name: "2027",
            startDate: "2027-01-01",
            periodEndDates: ["2027-06-30", "2027-03-31"],
          }),
        "FISCAL_YEAR_NOT_CONTIGUOUS",
      );
      await ledger.refuses(
        () =>
          ledger.openFiscalYear({
            name: "2026",
            startDate: "2027-01-01",
            periodEndDates: ["2027-12-31"],
          }),
        "FISCAL_YEAR_NAME_TAKEN",
      );
      await ledger.openFiscalYear({
        name: "2027",
        startDate: "2027-01-01",
        periodEndDates: ["2027-06-30", "2027-12-31"],
      });
      await ledger.post({ name: "jan", journal: "sales", date: "2026-01-10", lines: sale });
      await ledger.post({ name: "feb", journal: "sales", date: "2026-02-10", lines: sale });
      await ledger.post({ name: "next", journal: "sales", date: "2027-07-01", lines: sale });

      expect(await ledger.trialBalance("p1")).toEqual({ "1300": [100n, 0n], "8000": [0n, 100n] });
      expect(await ledger.trialBalance("p12")).toEqual({ "1300": [200n, 0n], "8000": [0n, 200n] });
      expect(await ledger.trialBalance("p13")).toEqual({});
      expect(await ledger.trialBalance("p14")).toEqual({ "1300": [100n, 0n], "8000": [0n, 100n] });
      expect((await ledger.fiscalYears())[1]).toMatchObject({
        number: 2,
        startDate: "2027-01-01",
        endDate: "2027-12-31",
        periods: [
          { startDate: "2027-01-01", endDate: "2027-06-30" },
          { startDate: "2027-07-01", endDate: "2027-12-31" },
        ],
      });
    }));
});
