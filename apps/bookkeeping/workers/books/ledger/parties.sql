CREATE TABLE party (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;

CREATE TABLE party_identifier (
  party_id TEXT NOT NULL REFERENCES party (id),
  kind TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (party_id, kind, jurisdiction)
) STRICT,
WITHOUT ROWID;

-- Structured to map onto UBL/Peppol PostalAddress.
CREATE TABLE party_address (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES party (id),
  purpose TEXT NOT NULL CHECK (purpose IN ('registered', 'billing', 'delivery')),
  street_line_1 TEXT NOT NULL,
  street_line_2 TEXT,
  -- NULL where the country has no postal codes or subdivisions.
  postal_code TEXT,
  city TEXT NOT NULL,
  subdivision TEXT,
  country_code TEXT NOT NULL CHECK (length(country_code) = 2)
) STRICT;

CREATE TABLE party_contact (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES party (id),
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'phone')),
  value TEXT NOT NULL
) STRICT;

-- Separate roles allow one party to be both customer and supplier. Customers post to a
-- receivable control account, suppliers to a payable one. control_role exists only so the
-- composite foreign key can require that role on the account.
CREATE TABLE party_account (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES party (id),
  role TEXT NOT NULL CHECK (role IN ('customer', 'supplier')),
  code TEXT NOT NULL,
  control_account_id TEXT NOT NULL,
  control_role TEXT GENERATED ALWAYS AS (
    CASE role
      WHEN 'customer' THEN 'receivable'
      ELSE 'payable'
    END
  ) VIRTUAL,
  UNIQUE (party_id, role),
  UNIQUE (role, code),
  UNIQUE (id, role),
  UNIQUE (id, control_account_id),
  FOREIGN KEY (control_account_id, control_role) REFERENCES ledger_account (id, role)
) STRICT;

CREATE INDEX party_address_party ON party_address (party_id);

CREATE INDEX party_contact_party ON party_contact (party_id);
