-- Reporting hierarchies (e.g. RGS) are independent of the chart: an account can be classified
-- differently in multiple schemes without changing its accounting identity.
CREATE TABLE classification_scheme (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
) STRICT;

CREATE TABLE classification_node (
  id TEXT PRIMARY KEY,
  scheme_id TEXT NOT NULL REFERENCES classification_scheme (id),
  parent_id TEXT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (scheme_id, code),
  UNIQUE (scheme_id, id),
  CHECK (
    parent_id IS NULL
    OR parent_id <> id
  ),
  FOREIGN KEY (scheme_id, parent_id) REFERENCES classification_node (scheme_id, id)
) STRICT;

CREATE TABLE classification_account (
  ledger_account_id TEXT NOT NULL REFERENCES ledger_account (id),
  scheme_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  PRIMARY KEY (ledger_account_id, scheme_id),
  FOREIGN KEY (scheme_id, node_id) REFERENCES classification_node (scheme_id, id)
) STRICT,
WITHOUT ROWID;

-- Inserts cannot create cycles because the parent must already exist.
CREATE TRIGGER classification_node_no_cycle BEFORE
UPDATE OF parent_id ON classification_node WHEN NEW.parent_id IS NOT NULL BEGIN
SELECT
  RAISE (
    ABORT,
    'Classification hierarchies must not contain cycles'
  )
WHERE
  EXISTS (
    WITH RECURSIVE
      ancestor (id) AS (
        SELECT
          NEW.parent_id
        UNION
        SELECT
          n.parent_id
        FROM
          classification_node n
          JOIN ancestor a ON n.id = a.id
        WHERE
          n.parent_id IS NOT NULL
      )
    SELECT
      1
    FROM
      ancestor
    WHERE
      id = NEW.id
  );

END;

CREATE INDEX classification_accounts ON classification_account (scheme_id, node_id);
