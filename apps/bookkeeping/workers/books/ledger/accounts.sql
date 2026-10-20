-- role is the posting behaviour the ledger itself enforces: receivable and payable accounts are
-- control accounts whose lines need a party. Banking and VAT designate their accounts in
-- their own tables. type and classification schemes drive reporting.
CREATE TABLE ledger_account (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (
    type IN (
      'asset',
      'liability',
      'equity',
      'revenue',
      'expense'
    )
  ),
  normal_side TEXT NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  role TEXT NOT NULL CHECK (role IN ('ordinary', 'receivable', 'payable')),
  -- NULL: the account accepts postings in any transaction currency.
  currency_code TEXT REFERENCES currency (code),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  UNIQUE (id, role),
  CHECK (
    role <> 'receivable'
    OR type = 'asset'
  ),
  CHECK (
    role <> 'payable'
    OR type = 'liability'
  )
) STRICT;

CREATE TABLE journal (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
) STRICT;
