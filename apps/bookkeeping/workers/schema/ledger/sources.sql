-- Each area registers the source kinds it owns, so adding one does not edit the ledger.
CREATE TABLE source_kind (code TEXT PRIMARY KEY) STRICT;

INSERT INTO
  source_kind (code)
VALUES
  ('manual_journal'),
  ('opening_balance');

-- Typed source tables attach to this identity with a composite key on (id, kind), so a
-- typed record can only extend a source document of its own kind.
CREATE TABLE source_document (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL REFERENCES source_kind (code),
  document_date TEXT NOT NULL CHECK (document_date = date(document_date)),
  description TEXT NOT NULL,
  UNIQUE (id, kind)
) STRICT;

CREATE TABLE document_attachment (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES source_document (id),
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_key TEXT NOT NULL
) STRICT;

CREATE INDEX attachment_source ON document_attachment (source_document_id);
