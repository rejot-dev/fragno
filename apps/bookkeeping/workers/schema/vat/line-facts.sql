-- The entry that clears VAT accounts into the amount due when a return is filed.
INSERT INTO
  source_kind (code)
VALUES
  ('vat_settlement');

-- Reporting facts for one taxed line of an entry, in the functional currency. Signed: credit
-- notes and reversals carry negative amounts. The VAT itself is booked on separate lines to
-- the code's accounts. accounting_period_id is copied from the entry so returns read VAT
-- tables only; it is checked on insert and again when the entry posts.
CREATE TABLE vat_line_fact (
  entry_id TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  vat_code_version_id TEXT NOT NULL REFERENCES vat_code_version (id),
  tax_date TEXT NOT NULL CHECK (tax_date = date(tax_date)),
  accounting_period_id TEXT NOT NULL REFERENCES accounting_period (id),
  base_functional_minor INTEGER NOT NULL,
  vat_functional_minor INTEGER NOT NULL,
  PRIMARY KEY (entry_id, line_number, vat_code_version_id),
  FOREIGN KEY (entry_id, line_number) REFERENCES journal_entry_line (entry_id, number)
) STRICT,
WITHOUT ROWID;

CREATE TRIGGER vat_line_fact_insert BEFORE INSERT ON vat_line_fact BEGIN
SELECT
  RAISE (ABORT, 'Posted VAT facts are immutable')
WHERE
  EXISTS (
    SELECT
      1
    FROM
      journal_entry
    WHERE
      id = NEW.entry_id
      AND status = 'posted'
  );

SELECT
  RAISE (
    ABORT,
    'VAT facts must carry the entry accounting period'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      journal_entry
    WHERE
      id = NEW.entry_id
      AND accounting_period_id = NEW.accounting_period_id
  );

END;

CREATE TRIGGER vat_line_fact_posted_no_update BEFORE
UPDATE ON vat_line_fact WHEN EXISTS (
  SELECT
    1
  FROM
    journal_entry
  WHERE
    status = 'posted'
    AND id IN (OLD.entry_id, NEW.entry_id)
) BEGIN
SELECT
  RAISE (ABORT, 'Posted VAT facts are immutable');

END;

CREATE TRIGGER vat_line_fact_posted_no_delete BEFORE DELETE ON vat_line_fact WHEN EXISTS (
  SELECT
    1
  FROM
    journal_entry
  WHERE
    id = OLD.entry_id
    AND status = 'posted'
) BEGIN
SELECT
  RAISE (ABORT, 'Posted VAT facts are immutable');

END;

-- Runs beside the ledger's own posting checks.
CREATE TRIGGER vat_journal_entry_post BEFORE
UPDATE OF status ON journal_entry WHEN OLD.status = 'draft'
AND NEW.status = 'posted' BEGIN
SELECT
  RAISE (
    ABORT,
    'VAT facts must carry the entry accounting period'
  )
WHERE
  EXISTS (
    SELECT
      1
    FROM
      vat_line_fact
    WHERE
      entry_id = OLD.id
      AND accounting_period_id <> NEW.accounting_period_id
  );

SELECT
  RAISE (
    ABORT,
    'Entries posting to VAT accounts need VAT facts'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      vat_line_fact
    WHERE
      entry_id = OLD.id
  )
  AND NOT EXISTS (
    SELECT
      1
    FROM
      source_document
    WHERE
      id = NEW.source_document_id
      AND kind = 'vat_settlement'
  )
  AND EXISTS (
    SELECT
      1
    FROM
      journal_entry_line l
      JOIN vat_code c ON l.ledger_account_id IN (c.payable_account_id, c.recoverable_account_id)
    WHERE
      l.entry_id = OLD.id
  );

-- Grouped with counts so duplicate facts must be negated as often as they occur.
SELECT
  RAISE (
    ABORT,
    'A reversal must negate the original VAT facts'
  )
WHERE
  NEW.reverses_entry_id IS NOT NULL
  AND (
    EXISTS (
      SELECT
        vat_code_version_id,
        - base_functional_minor,
        - vat_functional_minor,
        COUNT(*)
      FROM
        vat_line_fact
      WHERE
        entry_id = NEW.reverses_entry_id
      GROUP BY
        1,
        2,
        3
      EXCEPT
      SELECT
        vat_code_version_id,
        base_functional_minor,
        vat_functional_minor,
        COUNT(*)
      FROM
        vat_line_fact
      WHERE
        entry_id = OLD.id
      GROUP BY
        1,
        2,
        3
    )
    OR EXISTS (
      SELECT
        vat_code_version_id,
        base_functional_minor,
        vat_functional_minor,
        COUNT(*)
      FROM
        vat_line_fact
      WHERE
        entry_id = OLD.id
      GROUP BY
        1,
        2,
        3
      EXCEPT
      SELECT
        vat_code_version_id,
        - base_functional_minor,
        - vat_functional_minor,
        COUNT(*)
      FROM
        vat_line_fact
      WHERE
        entry_id = NEW.reverses_entry_id
      GROUP BY
        1,
        2,
        3
    )
  );

END;

CREATE INDEX vat_line_fact_period ON vat_line_fact (accounting_period_id, vat_code_version_id);
