INSERT INTO
  source_kind (code)
VALUES
  ('bank_transaction');

-- Statements and their transactions are imported facts from the bank, kept apart from their
-- bookings. The importer checks opening + transactions = closing before accepting a statement.
CREATE TABLE bank_statement (
  id TEXT PRIMARY KEY,
  bank_account_id TEXT NOT NULL REFERENCES bank_account (id),
  external_reference TEXT NOT NULL,
  start_date TEXT NOT NULL CHECK (start_date = date(start_date)),
  end_date TEXT NOT NULL CHECK (end_date = date(end_date)),
  opening_balance_minor INTEGER NOT NULL,
  closing_balance_minor INTEGER NOT NULL,
  UNIQUE (bank_account_id, external_reference),
  CHECK (end_date >= start_date)
) STRICT;

-- source_kind exists only so the composite foreign key can require the matching kind.
CREATE TABLE bank_transaction (
  source_document_id TEXT PRIMARY KEY,
  source_kind TEXT GENERATED ALWAYS AS ('bank_transaction') VIRTUAL,
  statement_id TEXT NOT NULL REFERENCES bank_statement (id),
  external_reference TEXT NOT NULL,
  booking_date TEXT NOT NULL CHECK (booking_date = date(booking_date)),
  value_date TEXT NOT NULL CHECK (value_date = date(value_date)),
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  counterparty_description TEXT NOT NULL,
  UNIQUE (statement_id, external_reference),
  FOREIGN KEY (source_document_id, source_kind) REFERENCES source_document (id, kind)
) STRICT;

CREATE TRIGGER bank_statement_no_update BEFORE
UPDATE ON bank_statement BEGIN
SELECT
  RAISE (ABORT, 'Imported statements are immutable');

END;

CREATE TRIGGER bank_transaction_no_update BEFORE
UPDATE ON bank_transaction BEGIN
SELECT
  RAISE (ABORT, 'Imported bank transactions are immutable');

END;

CREATE INDEX bank_transaction_statement ON bank_transaction (statement_id, booking_date);
