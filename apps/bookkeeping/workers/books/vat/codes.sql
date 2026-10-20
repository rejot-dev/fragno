-- A VAT code is one policy for one direction. Its accounts follow from that policy:
-- * standard sales: VAT payable; standard purchase: VAT recoverable
-- * reverse-charge purchase: both, since the buyer self-assesses and reclaims
-- * reverse-charge sales, zero rate and exempt: none, because no VAT is booked
-- The ledger knows nothing about VAT; these references are what make an account a VAT account.
CREATE TABLE vat_code (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  jurisdiction TEXT NOT NULL CHECK (length(jurisdiction) = 2),
  direction TEXT NOT NULL CHECK (direction IN ('sales', 'purchase')),
  treatment TEXT NOT NULL CHECK (
    treatment IN ('standard', 'zero', 'exempt', 'reverse_charge')
  ),
  payable_account_id TEXT REFERENCES ledger_account (id),
  recoverable_account_id TEXT REFERENCES ledger_account (id),
  CHECK (
    (payable_account_id IS NOT NULL) = (
      (
        treatment = 'standard'
        AND direction = 'sales'
      )
      OR (
        treatment = 'reverse_charge'
        AND direction = 'purchase'
      )
    )
  ),
  CHECK (
    (recoverable_account_id IS NOT NULL) = (
      treatment IN ('standard', 'reverse_charge')
      AND direction = 'purchase'
    )
  )
) STRICT;

-- Dated versions preserve the rate used historically. Rates are parts per million:
-- 21% = 210000. recoverable_ppm is the deductible share of purchase VAT.
CREATE TABLE vat_code_version (
  id TEXT PRIMARY KEY,
  vat_code_id TEXT NOT NULL REFERENCES vat_code (id),
  valid_from TEXT NOT NULL CHECK (valid_from = date(valid_from)),
  rate_ppm INTEGER NOT NULL CHECK (rate_ppm BETWEEN 0 AND 1000000),
  recoverable_ppm INTEGER NOT NULL CHECK (recoverable_ppm BETWEEN 0 AND 1000000),
  UNIQUE (vat_code_id, valid_from)
) STRICT;

CREATE TRIGGER vat_code_insert BEFORE INSERT ON vat_code BEGIN
SELECT
  RAISE (
    ABORT,
    'VAT payable accounts are ordinary liability accounts'
  )
WHERE
  NEW.payable_account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT
      1
    FROM
      ledger_account
    WHERE
      id = NEW.payable_account_id
      AND type = 'liability'
      AND role = 'ordinary'
  );

SELECT
  RAISE (
    ABORT,
    'VAT recoverable accounts are ordinary asset accounts'
  )
WHERE
  NEW.recoverable_account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT
      1
    FROM
      ledger_account
    WHERE
      id = NEW.recoverable_account_id
      AND type = 'asset'
      AND role = 'ordinary'
  );

END;

-- Returns and posted facts interpret history through the code; publish a new code instead.
CREATE TRIGGER vat_code_policy_frozen BEFORE
UPDATE OF jurisdiction,
direction,
treatment,
payable_account_id,
recoverable_account_id ON vat_code BEGIN
SELECT
  RAISE (
    ABORT,
    'VAT code policy is immutable; create a new code'
  );

END;

CREATE TRIGGER vat_code_version_immutable BEFORE
UPDATE ON vat_code_version BEGIN
SELECT
  RAISE (
    ABORT,
    'VAT code versions are immutable; publish a new version'
  );

END;

CREATE TRIGGER vat_account_semantics_frozen BEFORE
UPDATE OF type,
role ON ledger_account WHEN (NEW.type, NEW.role) IS NOT (OLD.type, OLD.role)
AND EXISTS (
  SELECT
    1
  FROM
    vat_code
  WHERE
    OLD.id IN (payable_account_id, recoverable_account_id)
) BEGIN
SELECT
  RAISE (ABORT, 'VAT accounts keep their type and role');

END;
