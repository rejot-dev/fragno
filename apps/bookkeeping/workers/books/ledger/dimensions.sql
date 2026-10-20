CREATE TABLE dimension (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
) STRICT;

CREATE TABLE dimension_value (
  id TEXT PRIMARY KEY,
  dimension_id TEXT NOT NULL REFERENCES dimension (id),
  parent_id TEXT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (dimension_id, code),
  UNIQUE (dimension_id, id),
  CHECK (
    parent_id IS NULL
    OR parent_id <> id
  ),
  FOREIGN KEY (dimension_id, parent_id) REFERENCES dimension_value (dimension_id, id)
) STRICT;

-- Every row that carries dimensions references one immutable, deduplicated set of dimension
-- values, so dimensional grain is a plain key and posted dimensions cannot drift. The
-- application builds canonical_key from the sorted dimension=value pairs ('' for the empty
-- set) and inserts the values before anything references the set. Each area that
-- references sets seals them with its own trigger on dimension_set_value.
CREATE TABLE dimension_set (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE dimension_set_value (
  set_id TEXT NOT NULL REFERENCES dimension_set (id),
  dimension_id TEXT NOT NULL,
  value_id TEXT NOT NULL,
  PRIMARY KEY (set_id, dimension_id),
  FOREIGN KEY (dimension_id, value_id) REFERENCES dimension_value (dimension_id, id)
) STRICT,
WITHOUT ROWID;

-- No row means the dimension is optional on that account. Checked when posting.
CREATE TABLE ledger_account_dimension_rule (
  ledger_account_id TEXT NOT NULL REFERENCES ledger_account (id),
  dimension_id TEXT NOT NULL REFERENCES dimension (id),
  requirement TEXT NOT NULL CHECK (requirement IN ('required', 'forbidden')),
  PRIMARY KEY (ledger_account_id, dimension_id)
) STRICT,
WITHOUT ROWID;

-- Inserts cannot create cycles because the parent must already exist.
CREATE TRIGGER dimension_value_no_cycle BEFORE
UPDATE OF parent_id ON dimension_value WHEN NEW.parent_id IS NOT NULL BEGIN
SELECT
  RAISE (
    ABORT,
    'Dimension hierarchies must not contain cycles'
  )
WHERE
  EXISTS (
    WITH RECURSIVE
      ancestor (id) AS (
        SELECT
          NEW.parent_id
        UNION
        SELECT
          v.parent_id
        FROM
          dimension_value v
          JOIN ancestor a ON v.id = a.id
        WHERE
          v.parent_id IS NOT NULL
      )
    SELECT
      1
    FROM
      ancestor
    WHERE
      id = NEW.id
  );

END;

CREATE TRIGGER dimension_set_no_update BEFORE
UPDATE ON dimension_set BEGIN
SELECT
  RAISE (ABORT, 'Dimension sets are immutable');

END;

CREATE TRIGGER dimension_set_no_delete BEFORE DELETE ON dimension_set BEGIN
SELECT
  RAISE (ABORT, 'Dimension sets are immutable');

END;

CREATE TRIGGER dimension_set_value_no_update BEFORE
UPDATE ON dimension_set_value BEGIN
SELECT
  RAISE (ABORT, 'Dimension sets are immutable');

END;

CREATE TRIGGER dimension_set_value_no_delete BEFORE DELETE ON dimension_set_value BEGIN
SELECT
  RAISE (ABORT, 'Dimension sets are immutable');

END;

CREATE INDEX dimension_set_value_lookup ON dimension_set_value (dimension_id, value_id);
