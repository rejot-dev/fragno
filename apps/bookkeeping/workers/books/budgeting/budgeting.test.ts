import { describe, expect, test } from "vitest";

import { bookkeepingScenario } from "../books.test-support";

describe("budgeting", () => {
  test("budget lines have the grain of posted actuals within the scenario year", () =>
    bookkeepingScenario((books) => {
      books.script(
        `INSERT INTO fiscal_year VALUES ('fy27', '2027', '2027-01-01', '2027-12-31');
         INSERT INTO accounting_period VALUES ('p27-1', 'fy27', 1, '2027-01-01', '2027-01-31', 'open');
         INSERT INTO budget_scenario VALUES ('plan', 'fy26', 'Plan 2026', 'draft')`,
      );
      books.sql("INSERT INTO budget_line VALUES ('plan', 'p1', 'costs', 'sales', 5000)");
      books.rejects(
        () => books.sql("INSERT INTO budget_line VALUES ('plan', 'p1', 'costs', 'sales', 7000)"),
        "UNIQUE",
      );
      books.rejects(
        () => books.sql("INSERT INTO budget_line VALUES ('plan', 'p27-1', 'costs', 'sales', 7000)"),
        "Budget periods must belong to the scenario fiscal year",
      );
      books.sql("INSERT INTO budget_line VALUES ('plan', 'p2', 'costs', 'unused', 7000)");
      books.rejects(
        () => books.sql("INSERT INTO dimension_set_value VALUES ('unused', 'cc', 'cc-support')"),
        "Dimension sets are sealed once referenced",
      );

      expect(books.sql("SELECT SUM(amount_minor) AS total FROM budget_line")).toEqual([
        { total: 12000 },
      ]);
    }));
});
