CREATE TABLE budget_scenario (
  id TEXT PRIMARY KEY,
  fiscal_year_id TEXT NOT NULL REFERENCES fiscal_year (id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'locked')),
  UNIQUE (fiscal_year_id, name)
) STRICT;

-- Budgets are signed functional-currency amounts, positive on the account's normal side.
-- The key matches the grain of posted actuals, so budget versus actual is a join.
CREATE TABLE budget_line (
  scenario_id TEXT NOT NULL REFERENCES budget_scenario (id),
  accounting_period_id TEXT NOT NULL REFERENCES accounting_period (id),
  ledger_account_id TEXT NOT NULL REFERENCES ledger_account (id),
  dimension_set_id TEXT NOT NULL REFERENCES dimension_set (id),
  amount_minor INTEGER NOT NULL,
  PRIMARY KEY (
    scenario_id,
    accounting_period_id,
    ledger_account_id,
    dimension_set_id
  )
) STRICT,
WITHOUT ROWID;

CREATE TRIGGER budget_line_period_in_year BEFORE INSERT ON budget_line BEGIN
SELECT
  RAISE (
    ABORT,
    'Budget periods must belong to the scenario fiscal year'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      budget_scenario s
      JOIN accounting_period p ON p.fiscal_year_id = s.fiscal_year_id
    WHERE
      s.id = NEW.scenario_id
      AND p.id = NEW.accounting_period_id
  );

END;

CREATE TRIGGER budget_dimension_set_sealed BEFORE INSERT ON dimension_set_value WHEN EXISTS (
  SELECT
    1
  FROM
    budget_line
  WHERE
    dimension_set_id = NEW.set_id
) BEGIN
SELECT
  RAISE (
    ABORT,
    'Dimension sets are sealed once referenced'
  );

END;

CREATE INDEX budget_line_dimension_set ON budget_line (dimension_set_id);
