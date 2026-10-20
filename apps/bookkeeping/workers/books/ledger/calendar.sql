CREATE TABLE currency (
  code TEXT PRIMARY KEY,
  minor_unit_digits INTEGER NOT NULL CHECK (minor_unit_digits BETWEEN 0 AND 6)
) STRICT;

CREATE TABLE administration (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  name TEXT NOT NULL,
  functional_currency TEXT NOT NULL REFERENCES currency (code)
) STRICT;

-- Functional-currency units per one unit of the foreign currency, scaled by 10^9, valid
-- until the next valid_from. Postings snapshot their own amounts; these rates feed defaults
-- and revaluation.
CREATE TABLE exchange_rate (
  currency_code TEXT NOT NULL REFERENCES currency (code),
  valid_from TEXT NOT NULL CHECK (valid_from = date(valid_from)),
  rate_nanos INTEGER NOT NULL CHECK (rate_nanos > 0),
  PRIMARY KEY (currency_code, valid_from)
) STRICT,
WITHOUT ROWID;

CREATE TABLE fiscal_year (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL CHECK (start_date = date(start_date)),
  end_date TEXT NOT NULL CHECK (end_date = date(end_date)),
  CHECK (end_date >= start_date)
) STRICT;

-- Closed periods can reopen for corrections; locked periods (returns filed) cannot.
CREATE TABLE accounting_period (
  id TEXT PRIMARY KEY,
  fiscal_year_id TEXT NOT NULL REFERENCES fiscal_year (id),
  number INTEGER NOT NULL CHECK (number > 0),
  start_date TEXT NOT NULL CHECK (start_date = date(start_date)),
  end_date TEXT NOT NULL CHECK (end_date = date(end_date)),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'locked')),
  UNIQUE (fiscal_year_id, number),
  CHECK (end_date >= start_date)
) STRICT;

-- Bounds are immutable: fix a wrong year or period by deleting it while unused.
CREATE TRIGGER fiscal_year_no_overlap BEFORE INSERT ON fiscal_year BEGIN
SELECT
  RAISE (ABORT, 'Fiscal years must not overlap')
WHERE
  EXISTS (
    SELECT
      1
    FROM
      fiscal_year
    WHERE
      start_date <= NEW.end_date
      AND NEW.start_date <= end_date
  );

END;

CREATE TRIGGER fiscal_year_bounds_immutable BEFORE
UPDATE OF start_date,
end_date ON fiscal_year BEGIN
SELECT
  RAISE (ABORT, 'Fiscal year bounds are immutable');

END;

CREATE TRIGGER accounting_period_insert BEFORE INSERT ON accounting_period BEGIN
SELECT
  RAISE (ABORT, 'New periods must be open')
WHERE
  NEW.status <> 'open';

SELECT
  RAISE (
    ABORT,
    'Periods must lie within their fiscal year'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      fiscal_year y
    WHERE
      y.id = NEW.fiscal_year_id
      AND NEW.start_date >= y.start_date
      AND NEW.end_date <= y.end_date
  );

SELECT
  RAISE (ABORT, 'Periods must not overlap')
WHERE
  EXISTS (
    SELECT
      1
    FROM
      accounting_period
    WHERE
      start_date <= NEW.end_date
      AND NEW.start_date <= end_date
  );

END;

CREATE TRIGGER accounting_period_bounds_immutable BEFORE
UPDATE OF fiscal_year_id,
number,
start_date,
end_date ON accounting_period BEGIN
SELECT
  RAISE (ABORT, 'Period bounds are immutable');

END;

CREATE TRIGGER accounting_period_status BEFORE
UPDATE OF status ON accounting_period WHEN NOT (
  OLD.status = NEW.status
  OR (
    OLD.status = 'open'
    AND NEW.status = 'closed'
  )
  OR (
    OLD.status = 'closed'
    AND NEW.status IN ('open', 'locked')
  )
) BEGIN
SELECT
  RAISE (ABORT, 'Periods move open <-> closed -> locked');

END;
