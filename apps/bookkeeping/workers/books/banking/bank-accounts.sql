-- NULL owner means the administration's own account.
CREATE TABLE bank_account (
  id TEXT PRIMARY KEY,
  owner_party_id TEXT REFERENCES party (id),
  identifier TEXT NOT NULL UNIQUE,
  currency_code TEXT NOT NULL REFERENCES currency (code)
) STRICT;

-- Designates the ledger account that books an own bank account. The ledger knows nothing about
-- banks; this link is what makes an ordinary asset account a bank account.
CREATE TABLE bank_ledger_account (
  bank_account_id TEXT PRIMARY KEY REFERENCES bank_account (id),
  ledger_account_id TEXT NOT NULL UNIQUE REFERENCES ledger_account (id)
) STRICT;

CREATE TRIGGER bank_ledger_account_insert BEFORE INSERT ON bank_ledger_account BEGIN
SELECT
  RAISE (
    ABORT,
    'Only own bank accounts are booked in the ledger'
  )
WHERE
  EXISTS (
    SELECT
      1
    FROM
      bank_account
    WHERE
      id = NEW.bank_account_id
      AND owner_party_id IS NOT NULL
  );

SELECT
  RAISE (
    ABORT,
    'Bank ledger accounts are ordinary asset accounts in the bank currency'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      ledger_account a
      JOIN bank_account b ON b.id = NEW.bank_account_id
    WHERE
      a.id = NEW.ledger_account_id
      AND a.type = 'asset'
      AND a.role = 'ordinary'
      AND a.currency_code IS b.currency_code
  );

END;

CREATE TRIGGER bank_ledger_account_no_update BEFORE
UPDATE ON bank_ledger_account BEGIN
SELECT
  RAISE (ABORT, 'Bank ledger links are immutable');

END;

CREATE TRIGGER bank_account_currency_frozen BEFORE
UPDATE OF currency_code,
owner_party_id ON bank_account WHEN EXISTS (
  SELECT
    1
  FROM
    bank_ledger_account
  WHERE
    bank_account_id = OLD.id
) BEGIN
SELECT
  RAISE (
    ABORT,
    'Linked bank accounts keep their owner and currency'
  );

END;

-- The ledger only freezes account semantics once postings exist; a linked account must keep
-- them from the moment it is linked.
CREATE TRIGGER bank_ledger_account_semantics_frozen BEFORE
UPDATE OF type,
role,
currency_code ON ledger_account WHEN (NEW.type, NEW.role, NEW.currency_code) IS NOT (OLD.type, OLD.role, OLD.currency_code)
AND EXISTS (
  SELECT
    1
  FROM
    bank_ledger_account
  WHERE
    ledger_account_id = OLD.id
) BEGIN
SELECT
  RAISE (
    ABORT,
    'Bank ledger accounts keep their type, role and currency'
  );

END;
