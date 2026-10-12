CREATE TABLE invoice_payment_terms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  due_days INTEGER NOT NULL CHECK (due_days >= 0)
) STRICT;

-- Default terms per customer or supplier. They only seed an invoice's due date; the ledger's
-- open-item line carries the due date that applies.
CREATE TABLE invoice_party_terms (
  party_account_id TEXT PRIMARY KEY REFERENCES party_account (id),
  payment_terms_id TEXT NOT NULL REFERENCES invoice_payment_terms (id)
) STRICT;
