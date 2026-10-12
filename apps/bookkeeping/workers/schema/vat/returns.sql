-- Which return box reports a code's base or VAT amount, from valid_from until the code's next
-- mapping date. Dated so mappings follow changes in the law without rewriting history.
CREATE TABLE vat_box_mapping (
  vat_code_id TEXT NOT NULL REFERENCES vat_code (id),
  valid_from TEXT NOT NULL CHECK (valid_from = date(valid_from)),
  box TEXT NOT NULL,
  component TEXT NOT NULL CHECK (component IN ('base', 'vat')),
  PRIMARY KEY (vat_code_id, valid_from, box, component)
) STRICT,
WITHOUT ROWID;

-- A filed return. Filing locks the periods it covers, so their facts can no longer change;
-- corrections go into a later return. A return and its periods and boxes are written in one
-- transaction and never change afterwards.
CREATE TABLE vat_return (
  id TEXT PRIMARY KEY,
  filed_at TEXT NOT NULL CHECK (
    filed_at = strftime('%Y-%m-%dT%H:%M:%fZ', filed_at)
  ),
  filed_by TEXT NOT NULL,
  -- NULL when the covered periods left nothing to clear.
  settlement_entry_id TEXT UNIQUE REFERENCES journal_entry (id)
) STRICT;

CREATE TABLE vat_return_period (
  accounting_period_id TEXT PRIMARY KEY REFERENCES accounting_period (id),
  vat_return_id TEXT NOT NULL REFERENCES vat_return (id)
) STRICT;

-- The box totals as filed: the legal record, independent of later mapping changes.
CREATE TABLE vat_return_box (
  vat_return_id TEXT NOT NULL REFERENCES vat_return (id),
  box TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  PRIMARY KEY (vat_return_id, box)
) STRICT,
WITHOUT ROWID;

CREATE TRIGGER vat_return_insert BEFORE INSERT ON vat_return WHEN NEW.settlement_entry_id IS NOT NULL BEGIN
SELECT
  RAISE (
    ABORT,
    'VAT settlement entries must be posted VAT settlements'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      journal_entry e
      JOIN source_document d ON d.id = e.source_document_id
    WHERE
      e.id = NEW.settlement_entry_id
      AND e.status = 'posted'
      AND d.kind = 'vat_settlement'
  );

END;

CREATE TRIGGER vat_return_period_insert BEFORE INSERT ON vat_return_period BEGIN
SELECT
  RAISE (ABORT, 'VAT returns cover closed periods')
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      accounting_period
    WHERE
      id = NEW.accounting_period_id
      AND status = 'closed'
  );

END;

CREATE TRIGGER vat_return_period_lock AFTER INSERT ON vat_return_period BEGIN
UPDATE accounting_period
SET
  status = 'locked'
WHERE
  id = NEW.accounting_period_id;

END;

CREATE TRIGGER vat_return_no_update BEFORE
UPDATE ON vat_return BEGIN
SELECT
  RAISE (ABORT, 'Filed VAT returns are immutable');

END;

CREATE TRIGGER vat_return_no_delete BEFORE DELETE ON vat_return BEGIN
SELECT
  RAISE (ABORT, 'Filed VAT returns are immutable');

END;

CREATE TRIGGER vat_return_period_no_update BEFORE
UPDATE ON vat_return_period BEGIN
SELECT
  RAISE (ABORT, 'Filed VAT returns are immutable');

END;

CREATE TRIGGER vat_return_period_no_delete BEFORE DELETE ON vat_return_period BEGIN
SELECT
  RAISE (ABORT, 'Filed VAT returns are immutable');

END;

CREATE TRIGGER vat_return_box_no_update BEFORE
UPDATE ON vat_return_box BEGIN
SELECT
  RAISE (ABORT, 'Filed VAT returns are immutable');

END;

CREATE TRIGGER vat_return_box_no_delete BEFORE DELETE ON vat_return_box BEGIN
SELECT
  RAISE (ABORT, 'Filed VAT returns are immutable');

END;

CREATE INDEX vat_return_period_return ON vat_return_period (vat_return_id);
