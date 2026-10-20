-- Settles a debit open item against a credit open item of the same party account, in their
-- shared transaction currency. Append-only: a correction is a reversing allocation.
-- party_account_id and currency_code are copied from the (immutable) allocated lines and
-- checked on insert, so per-party statements read allocations without joining the ledger.
-- difference_entry_id is the posted entry booking a realized FX difference or payment
-- discount caused by this settlement.
CREATE TABLE settlement_allocation (
  id TEXT PRIMARY KEY,
  party_account_id TEXT NOT NULL REFERENCES party_account (id),
  currency_code TEXT NOT NULL REFERENCES currency (code),
  debit_entry_id TEXT NOT NULL,
  debit_line_number INTEGER NOT NULL,
  credit_entry_id TEXT NOT NULL,
  credit_line_number INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  allocated_at TEXT NOT NULL CHECK (
    allocated_at = strftime('%Y-%m-%dT%H:%M:%fZ', allocated_at)
  ),
  allocated_by TEXT NOT NULL,
  reverses_allocation_id TEXT UNIQUE REFERENCES settlement_allocation (id),
  difference_entry_id TEXT REFERENCES journal_entry (id),
  CHECK (
    reverses_allocation_id IS NULL
    OR reverses_allocation_id <> id
  ),
  FOREIGN KEY (debit_entry_id, debit_line_number) REFERENCES journal_entry_line (entry_id, number),
  FOREIGN KEY (credit_entry_id, credit_line_number) REFERENCES journal_entry_line (entry_id, number)
) STRICT;

-- Allocations in force: neither reversing nor reversed.
CREATE VIEW active_settlement_allocation AS
SELECT
  a.*
FROM
  settlement_allocation a
WHERE
  a.reverses_allocation_id IS NULL
  AND NOT EXISTS (
    SELECT
      1
    FROM
      settlement_allocation r
    WHERE
      r.reverses_allocation_id = a.id
  );

-- Open items are posted party lines; outstanding is in the line's transaction currency.
CREATE VIEW open_item AS
SELECT
  l.entry_id,
  l.number AS line_number,
  l.party_account_id,
  l.side,
  l.transaction_currency,
  l.due_date,
  l.transaction_amount_minor - COALESCE(
    (
      SELECT
        SUM(a.amount_minor)
      FROM
        active_settlement_allocation a
      WHERE
        (
          a.debit_entry_id = l.entry_id
          AND a.debit_line_number = l.number
        )
        OR (
          a.credit_entry_id = l.entry_id
          AND a.credit_line_number = l.number
        )
    ),
    0
  ) AS outstanding_minor
FROM
  journal_entry_line l
  JOIN journal_entry e ON e.id = l.entry_id
WHERE
  e.status = 'posted'
  AND l.party_account_id IS NOT NULL;

CREATE TRIGGER settlement_allocation_insert BEFORE INSERT ON settlement_allocation WHEN NEW.reverses_allocation_id IS NULL BEGIN
SELECT
  RAISE (
    ABORT,
    'Allocations settle a posted debit open item against a posted credit one'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      open_item
    WHERE
      entry_id = NEW.debit_entry_id
      AND line_number = NEW.debit_line_number
      AND side = 'debit'
  )
  OR NOT EXISTS (
    SELECT
      1
    FROM
      open_item
    WHERE
      entry_id = NEW.credit_entry_id
      AND line_number = NEW.credit_line_number
      AND side = 'credit'
  );

SELECT
  RAISE (
    ABORT,
    'Allocated items must share the allocation party account and currency'
  )
WHERE
  EXISTS (
    SELECT
      1
    FROM
      open_item
    WHERE
      (
        (
          entry_id = NEW.debit_entry_id
          AND line_number = NEW.debit_line_number
        )
        OR (
          entry_id = NEW.credit_entry_id
          AND line_number = NEW.credit_line_number
        )
      )
      AND (
        party_account_id <> NEW.party_account_id
        OR transaction_currency <> NEW.currency_code
      )
  );

SELECT
  RAISE (
    ABORT,
    'Allocation exceeds the outstanding amount'
  )
WHERE
  EXISTS (
    SELECT
      1
    FROM
      open_item
    WHERE
      (
        (
          entry_id = NEW.debit_entry_id
          AND line_number = NEW.debit_line_number
        )
        OR (
          entry_id = NEW.credit_entry_id
          AND line_number = NEW.credit_line_number
        )
      )
      AND outstanding_minor < NEW.amount_minor
  );

SELECT
  RAISE (ABORT, 'Difference entries must be posted')
WHERE
  NEW.difference_entry_id IS NOT NULL
  AND NOT EXISTS (
    SELECT
      1
    FROM
      journal_entry
    WHERE
      id = NEW.difference_entry_id
      AND status = 'posted'
  );

END;

-- A difference entry is undone by reversing it in the ledger, not through the allocation.
CREATE TRIGGER settlement_allocation_reversal BEFORE INSERT ON settlement_allocation WHEN NEW.reverses_allocation_id IS NOT NULL BEGIN
SELECT
  RAISE (
    ABORT,
    'A reversing allocation must mirror an active allocation'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      active_settlement_allocation a
    WHERE
      a.id = NEW.reverses_allocation_id
      AND a.party_account_id = NEW.party_account_id
      AND a.currency_code = NEW.currency_code
      AND a.debit_entry_id = NEW.debit_entry_id
      AND a.debit_line_number = NEW.debit_line_number
      AND a.credit_entry_id = NEW.credit_entry_id
      AND a.credit_line_number = NEW.credit_line_number
      AND a.amount_minor = NEW.amount_minor
  );

SELECT
  RAISE (
    ABORT,
    'Reversing allocations carry no difference entry'
  )
WHERE
  NEW.difference_entry_id IS NOT NULL;

END;

CREATE TRIGGER settlement_allocation_no_update BEFORE
UPDATE ON settlement_allocation BEGIN
SELECT
  RAISE (
    ABORT,
    'Allocations are append-only; insert a reversing allocation'
  );

END;

CREATE TRIGGER settlement_allocation_no_delete BEFORE DELETE ON settlement_allocation BEGIN
SELECT
  RAISE (
    ABORT,
    'Allocations are append-only; insert a reversing allocation'
  );

END;

CREATE INDEX allocation_party ON settlement_allocation (party_account_id, allocated_at);

CREATE INDEX allocation_debit ON settlement_allocation (debit_entry_id, debit_line_number);

CREATE INDEX allocation_credit ON settlement_allocation (credit_entry_id, credit_line_number);
