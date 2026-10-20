INSERT INTO
  source_kind (code)
VALUES
  ('sales_invoice'),
  ('purchase_invoice');

-- Issued invoices keep party/address snapshots in addition to the live relation.
-- Sales invoices get a gapless sequence_number when issued; purchase invoices carry the
-- supplier's own number, unique per supplier. Amounts are net: VAT attaches
-- its own amounts, and the application composes the invoice total from all of them.
-- source_kind exists only so the composite foreign key can require the matching kind.
CREATE TABLE invoice (
  source_document_id TEXT PRIMARY KEY,
  party_account_id TEXT NOT NULL,
  party_role TEXT NOT NULL CHECK (party_role IN ('customer', 'supplier')),
  source_kind TEXT GENERATED ALWAYS AS (
    CASE party_role
      WHEN 'customer' THEN 'sales_invoice'
      ELSE 'purchase_invoice'
    END
  ) VIRTUAL,
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  sequence_number INTEGER UNIQUE CHECK (sequence_number > 0),
  supplier_reference TEXT,
  party_name_snapshot TEXT NOT NULL,
  -- The party_address fields as a JSON object.
  billing_address_snapshot TEXT NOT NULL CHECK (json_valid(billing_address_snapshot)),
  due_date TEXT NOT NULL CHECK (due_date = date(due_date)),
  currency_code TEXT NOT NULL REFERENCES currency (code),
  status TEXT NOT NULL CHECK (status IN ('draft', 'issued')),
  UNIQUE (party_account_id, supplier_reference),
  CHECK (
    (party_role = 'supplier') = (supplier_reference IS NOT NULL)
  ),
  CHECK (
    (
      party_role = 'customer'
      AND status = 'issued'
    ) = (sequence_number IS NOT NULL)
  ),
  FOREIGN KEY (source_document_id, source_kind) REFERENCES source_document (id, kind),
  FOREIGN KEY (party_account_id, party_role) REFERENCES party_account (id, role)
) STRICT;

CREATE TABLE invoice_line (
  invoice_id TEXT NOT NULL REFERENCES invoice (source_document_id),
  number INTEGER NOT NULL CHECK (number > 0),
  description TEXT NOT NULL,
  quantity_microunits INTEGER NOT NULL CHECK (quantity_microunits > 0),
  net_amount_minor INTEGER NOT NULL CHECK (net_amount_minor >= 0),
  ledger_account_id TEXT NOT NULL REFERENCES ledger_account (id),
  dimension_set_id TEXT NOT NULL REFERENCES dimension_set (id),
  PRIMARY KEY (invoice_id, number)
) STRICT,
WITHOUT ROWID;

-- Issuing assigns the sales number; issued invoices never change, so numbers stay gapless.
-- Other areas (VAT) add their own issue checks as further BEFORE UPDATE OF status triggers.
CREATE TRIGGER invoice_insert_draft BEFORE INSERT ON invoice WHEN NEW.status <> 'draft' BEGIN
SELECT
  RAISE (ABORT, 'Create invoices as drafts before issuing');

END;

CREATE TRIGGER invoice_issue BEFORE
UPDATE OF status ON invoice WHEN OLD.status = 'draft'
AND NEW.status = 'issued' BEGIN
SELECT
  RAISE (ABORT, 'Issuing requires at least one line')
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      invoice_line
    WHERE
      invoice_id = NEW.source_document_id
  );

SELECT
  RAISE (ABORT, 'Sales invoice numbers are gapless')
WHERE
  NEW.party_role = 'customer'
  AND NEW.sequence_number IS NOT (
    SELECT
      COALESCE(MAX(sequence_number), 0) + 1
    FROM
      invoice
  );

END;

CREATE TRIGGER invoice_issued_no_update BEFORE
UPDATE ON invoice WHEN OLD.status = 'issued' BEGIN
SELECT
  RAISE (
    ABORT,
    'Issued invoices are immutable; issue a credit note'
  );

END;

CREATE TRIGGER invoice_issued_no_delete BEFORE DELETE ON invoice WHEN OLD.status = 'issued' BEGIN
SELECT
  RAISE (ABORT, 'Issued invoices cannot be deleted');

END;

-- Guard both OLD and NEW parents so a line cannot be moved out of an issued invoice.
CREATE TRIGGER invoice_line_issued_no_insert BEFORE INSERT ON invoice_line WHEN EXISTS (
  SELECT
    1
  FROM
    invoice
  WHERE
    source_document_id = NEW.invoice_id
    AND status = 'issued'
) BEGIN
SELECT
  RAISE (ABORT, 'Issued invoice lines are immutable');

END;

CREATE TRIGGER invoice_line_issued_no_update BEFORE
UPDATE ON invoice_line WHEN EXISTS (
  SELECT
    1
  FROM
    invoice
  WHERE
    status = 'issued'
    AND source_document_id IN (OLD.invoice_id, NEW.invoice_id)
) BEGIN
SELECT
  RAISE (ABORT, 'Issued invoice lines are immutable');

END;

CREATE TRIGGER invoice_line_issued_no_delete BEFORE DELETE ON invoice_line WHEN EXISTS (
  SELECT
    1
  FROM
    invoice
  WHERE
    source_document_id = OLD.invoice_id
    AND status = 'issued'
) BEGIN
SELECT
  RAISE (ABORT, 'Issued invoice lines are immutable');

END;

CREATE TRIGGER invoice_dimension_set_sealed BEFORE INSERT ON dimension_set_value WHEN EXISTS (
  SELECT
    1
  FROM
    invoice_line
  WHERE
    dimension_set_id = NEW.set_id
) BEGIN
SELECT
  RAISE (
    ABORT,
    'Dimension sets are sealed once referenced'
  );

END;

CREATE INDEX invoice_party ON invoice (party_account_id);

CREATE INDEX invoice_line_dimension_set ON invoice_line (dimension_set_id);
