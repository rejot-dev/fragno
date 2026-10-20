-- VAT on invoices. Every issued invoice carries VAT for each
-- line (a zero-rate or exempt code where no VAT applies), as EU invoices must state it.
CREATE TABLE vat_invoice (
  invoice_id TEXT PRIMARY KEY REFERENCES invoice (source_document_id),
  tax_date TEXT NOT NULL CHECK (tax_date = date(tax_date))
) STRICT;

-- One code per invoice line; the taxable base is the line's net amount.
CREATE TABLE vat_invoice_line (
  invoice_id TEXT NOT NULL REFERENCES vat_invoice (invoice_id),
  line_number INTEGER NOT NULL,
  vat_code_version_id TEXT NOT NULL REFERENCES vat_code_version (id),
  vat_amount_minor INTEGER NOT NULL CHECK (vat_amount_minor >= 0),
  PRIMARY KEY (invoice_id, line_number),
  FOREIGN KEY (invoice_id, line_number) REFERENCES invoice_line (invoice_id, number)
) STRICT,
WITHOUT ROWID;

CREATE TRIGGER vat_invoice_issued_no_insert BEFORE INSERT ON vat_invoice WHEN EXISTS (
  SELECT
    1
  FROM
    invoice
  WHERE
    source_document_id = NEW.invoice_id
    AND status = 'issued'
) BEGIN
SELECT
  RAISE (ABORT, 'Issued invoice VAT is immutable');

END;

CREATE TRIGGER vat_invoice_issued_no_update BEFORE
UPDATE ON vat_invoice WHEN EXISTS (
  SELECT
    1
  FROM
    invoice
  WHERE
    status = 'issued'
    AND source_document_id IN (OLD.invoice_id, NEW.invoice_id)
) BEGIN
SELECT
  RAISE (ABORT, 'Issued invoice VAT is immutable');

END;

CREATE TRIGGER vat_invoice_issued_no_delete BEFORE DELETE ON vat_invoice WHEN EXISTS (
  SELECT
    1
  FROM
    invoice
  WHERE
    source_document_id = OLD.invoice_id
    AND status = 'issued'
) BEGIN
SELECT
  RAISE (ABORT, 'Issued invoice VAT is immutable');

END;

CREATE TRIGGER vat_invoice_line_insert BEFORE INSERT ON vat_invoice_line BEGIN
SELECT
  RAISE (ABORT, 'Issued invoice VAT is immutable')
WHERE
  EXISTS (
    SELECT
      1
    FROM
      invoice
    WHERE
      source_document_id = NEW.invoice_id
      AND status = 'issued'
  );

SELECT
  RAISE (
    ABORT,
    'Sales invoices use sales VAT codes, purchase invoices purchase codes'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      invoice i,
      vat_code_version v
      JOIN vat_code c ON c.id = v.vat_code_id
    WHERE
      i.source_document_id = NEW.invoice_id
      AND v.id = NEW.vat_code_version_id
      AND c.direction = CASE i.party_role
        WHEN 'customer' THEN 'sales'
        ELSE 'purchase'
      END
  );

END;

CREATE TRIGGER vat_invoice_line_issued_no_update BEFORE
UPDATE ON vat_invoice_line WHEN EXISTS (
  SELECT
    1
  FROM
    invoice
  WHERE
    status = 'issued'
    AND source_document_id IN (OLD.invoice_id, NEW.invoice_id)
) BEGIN
SELECT
  RAISE (ABORT, 'Issued invoice VAT is immutable');

END;

CREATE TRIGGER vat_invoice_line_issued_no_delete BEFORE DELETE ON vat_invoice_line WHEN EXISTS (
  SELECT
    1
  FROM
    invoice
  WHERE
    source_document_id = OLD.invoice_id
    AND status = 'issued'
) BEGIN
SELECT
  RAISE (ABORT, 'Issued invoice VAT is immutable');

END;

-- Runs beside the invoice's own issue checks.
CREATE TRIGGER vat_invoice_issue BEFORE
UPDATE OF status ON invoice WHEN OLD.status = 'draft'
AND NEW.status = 'issued' BEGIN
SELECT
  RAISE (
    ABORT,
    'Issuing requires a VAT code on every line'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      vat_invoice
    WHERE
      invoice_id = NEW.source_document_id
  )
  OR EXISTS (
    SELECT
      1
    FROM
      invoice_line l
    WHERE
      l.invoice_id = NEW.source_document_id
      AND NOT EXISTS (
        SELECT
          1
        FROM
          vat_invoice_line v
        WHERE
          v.invoice_id = l.invoice_id
          AND v.line_number = l.number
      )
  );

END;
