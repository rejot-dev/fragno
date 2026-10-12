-- Reconciliation is distinct from settlement: one bank transaction can fund several ledger
-- postings, and one posting can combine several bank transactions. The application keeps
-- per-transaction and per-line totals within their amounts.
CREATE TABLE bank_reconciliation (
  bank_transaction_id TEXT NOT NULL REFERENCES bank_transaction (source_document_id),
  entry_id TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  PRIMARY KEY (bank_transaction_id, entry_id, line_number),
  FOREIGN KEY (entry_id, line_number) REFERENCES journal_entry_line (entry_id, number)
) STRICT,
WITHOUT ROWID;

CREATE TRIGGER bank_reconciliation_insert BEFORE INSERT ON bank_reconciliation BEGIN
SELECT
  RAISE (
    ABORT,
    'Reconcile posted lines on the ledger account of the statement bank account'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      bank_transaction t
      JOIN bank_statement s ON s.id = t.statement_id
      JOIN bank_ledger_account b ON b.bank_account_id = s.bank_account_id
      JOIN posted_ledger l ON l.ledger_account_id = b.ledger_account_id
    WHERE
      t.source_document_id = NEW.bank_transaction_id
      AND l.entry_id = NEW.entry_id
      AND l.number = NEW.line_number
  );

END;

CREATE INDEX bank_reconciliation_line ON bank_reconciliation (entry_id, line_number);
