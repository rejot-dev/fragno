-- entry_number is assigned when posting, gapless per journal; the Durable Object is the single
-- writer, so the next number cannot race. Drafts exist only inside the posting transaction
-- (insert draft, add lines, post): SQLite has no deferred checks, so the draft step is how the
-- posting triggers see the lines. A committed draft is an application bug; work that stays in
-- draft for longer belongs on a source document.
CREATE TABLE journal_entry (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES journal (id),
  source_document_id TEXT NOT NULL REFERENCES source_document (id),
  entry_number INTEGER CHECK (entry_number > 0),
  posting_date TEXT NOT NULL CHECK (posting_date = date(posting_date)),
  accounting_period_id TEXT NOT NULL REFERENCES accounting_period (id),
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'posted')),
  posted_at TEXT CHECK (
    posted_at = strftime('%Y-%m-%dT%H:%M:%fZ', posted_at)
  ),
  -- Opaque actor identifier from the application.
  posted_by TEXT,
  reverses_entry_id TEXT UNIQUE REFERENCES journal_entry (id),
  UNIQUE (journal_id, entry_number),
  CHECK ((status = 'posted') = (entry_number IS NOT NULL)),
  CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
  CHECK ((status = 'posted') = (posted_by IS NOT NULL)),
  CHECK (
    reverses_entry_id IS NULL
    OR reverses_entry_id <> id
  )
) STRICT;

-- A reversal is another posted entry, not a mutation of the original's status.
-- Transaction and functional amounts are separate snapshots. A zero functional amount
-- is possible for tiny foreign amounts; a zero transaction amount is possible for FX adjustments.
-- A line with a party is an open item: it posts to that party's control account and carries
-- its due date. Party information for other lines belongs in dimensions or source documents.
CREATE TABLE journal_entry_line (
  entry_id TEXT NOT NULL REFERENCES journal_entry (id),
  number INTEGER NOT NULL CHECK (number > 0),
  ledger_account_id TEXT NOT NULL REFERENCES ledger_account (id),
  side TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
  transaction_currency TEXT NOT NULL REFERENCES currency (code),
  transaction_amount_minor INTEGER NOT NULL CHECK (transaction_amount_minor >= 0),
  functional_amount_minor INTEGER NOT NULL CHECK (functional_amount_minor >= 0),
  description TEXT NOT NULL,
  dimension_set_id TEXT NOT NULL REFERENCES dimension_set (id),
  party_account_id TEXT,
  due_date TEXT CHECK (due_date = date(due_date)),
  PRIMARY KEY (entry_id, number),
  CHECK (
    transaction_amount_minor > 0
    OR functional_amount_minor > 0
  ),
  CHECK ((party_account_id IS NULL) = (due_date IS NULL)),
  FOREIGN KEY (party_account_id, ledger_account_id) REFERENCES party_account (id, control_account_id)
) STRICT,
WITHOUT ROWID;

CREATE VIEW posted_ledger AS
SELECT
  l.*,
  e.journal_id,
  e.entry_number,
  e.source_document_id,
  e.posting_date,
  e.accounting_period_id,
  CASE l.side
    WHEN 'debit' THEN l.functional_amount_minor
    ELSE - l.functional_amount_minor
  END AS signed_functional_amount_minor
FROM
  journal_entry_line l
  JOIN journal_entry e ON e.id = l.entry_id
WHERE
  e.status = 'posted';

-- Posting is a single transaction: insert the draft, write the lines (and any VAT facts),
-- then set status = 'posted' with the next entry_number, posted_by and
-- posted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'). Other areas (VAT) add their own posting checks as
-- further BEFORE UPDATE OF status triggers; any of them aborts the post.
CREATE TRIGGER journal_entry_insert_draft BEFORE INSERT ON journal_entry WHEN NEW.status <> 'draft' BEGIN
SELECT
  RAISE (ABORT, 'Create entries as drafts before posting');

END;

CREATE TRIGGER journal_entry_post BEFORE
UPDATE OF status ON journal_entry WHEN OLD.status = 'draft'
AND NEW.status = 'posted' BEGIN
SELECT
  RAISE (
    ABORT,
    'Posting requires an open period containing the posting date'
  )
WHERE
  NOT EXISTS (
    SELECT
      1
    FROM
      accounting_period p
    WHERE
      p.id = NEW.accounting_period_id
      AND p.status = 'open'
      AND NEW.posting_date BETWEEN p.start_date AND p.end_date
  );

SELECT
  RAISE (ABORT, 'Entry numbers are gapless per journal')
WHERE
  NEW.entry_number IS NOT (
    SELECT
      COALESCE(MAX(entry_number), 0) + 1
    FROM
      journal_entry
    WHERE
      journal_id = NEW.journal_id
  );

SELECT
  RAISE (ABORT, 'Posting requires at least two lines')
WHERE
  (
    SELECT
      COUNT(*)
    FROM
      journal_entry_line
    WHERE
      entry_id = OLD.id
  ) < 2;

SELECT
  RAISE (
    ABORT,
    'Functional currency debits and credits must balance'
  )
WHERE
  (
    SELECT
      SUM(
        CASE side
          WHEN 'debit' THEN functional_amount_minor
          ELSE - functional_amount_minor
        END
      )
    FROM
      journal_entry_line
    WHERE
      entry_id = OLD.id
  ) <> 0;

SELECT
  RAISE (ABORT, 'Posting requires active accounts')
WHERE
  EXISTS (
    SELECT
      1
    FROM
      journal_entry_line l
      JOIN ledger_account a ON a.id = l.ledger_account_id
    WHERE
      l.entry_id = OLD.id
      AND a.active = 0
  );

SELECT
  RAISE (ABORT, 'Control-account lines require a party')
WHERE
  EXISTS (
    SELECT
      1
    FROM
      journal_entry_line l
      JOIN ledger_account a ON a.id = l.ledger_account_id
    WHERE
      l.entry_id = OLD.id
      AND a.role IN ('receivable', 'payable')
      AND l.party_account_id IS NULL
  );

SELECT
  RAISE (
    ABORT,
    'Line currency must match the account currency'
  )
WHERE
  EXISTS (
    SELECT
      1
    FROM
      journal_entry_line l
      JOIN ledger_account a ON a.id = l.ledger_account_id
    WHERE
      l.entry_id = OLD.id
      AND a.currency_code IS NOT NULL
      AND a.currency_code <> l.transaction_currency
  );

SELECT
  RAISE (
    ABORT,
    'Lines must satisfy their account dimension rules'
  )
WHERE
  EXISTS (
    SELECT
      1
    FROM
      journal_entry_line l
      JOIN ledger_account_dimension_rule r ON r.ledger_account_id = l.ledger_account_id
    WHERE
      l.entry_id = OLD.id
      AND (r.requirement = 'required') <> EXISTS (
        SELECT
          1
        FROM
          dimension_set_value v
        WHERE
          v.set_id = l.dimension_set_id
          AND v.dimension_id = r.dimension_id
      )
  );

SELECT
  RAISE (ABORT, 'Only posted entries can be reversed')
WHERE
  NEW.reverses_entry_id IS NOT NULL
  AND NOT EXISTS (
    SELECT
      1
    FROM
      journal_entry
    WHERE
      id = NEW.reverses_entry_id
      AND status = 'posted'
  );

-- Grouped with counts so duplicate lines must be mirrored as often as they occur.
SELECT
  RAISE (
    ABORT,
    'A reversal must mirror the original lines with sides swapped'
  )
WHERE
  NEW.reverses_entry_id IS NOT NULL
  AND (
    EXISTS (
      SELECT
        ledger_account_id,
        CASE side
          WHEN 'debit' THEN 'credit'
          ELSE 'debit'
        END,
        transaction_currency,
        transaction_amount_minor,
        functional_amount_minor,
        dimension_set_id,
        party_account_id,
        COUNT(*)
      FROM
        journal_entry_line
      WHERE
        entry_id = NEW.reverses_entry_id
      GROUP BY
        1,
        2,
        3,
        4,
        5,
        6,
        7
      EXCEPT
      SELECT
        ledger_account_id,
        side,
        transaction_currency,
        transaction_amount_minor,
        functional_amount_minor,
        dimension_set_id,
        party_account_id,
        COUNT(*)
      FROM
        journal_entry_line
      WHERE
        entry_id = OLD.id
      GROUP BY
        1,
        2,
        3,
        4,
        5,
        6,
        7
    )
    OR EXISTS (
      SELECT
        ledger_account_id,
        side,
        transaction_currency,
        transaction_amount_minor,
        functional_amount_minor,
        dimension_set_id,
        party_account_id,
        COUNT(*)
      FROM
        journal_entry_line
      WHERE
        entry_id = OLD.id
      GROUP BY
        1,
        2,
        3,
        4,
        5,
        6,
        7
      EXCEPT
      SELECT
        ledger_account_id,
        CASE side
          WHEN 'debit' THEN 'credit'
          ELSE 'debit'
        END,
        transaction_currency,
        transaction_amount_minor,
        functional_amount_minor,
        dimension_set_id,
        party_account_id,
        COUNT(*)
      FROM
        journal_entry_line
      WHERE
        entry_id = NEW.reverses_entry_id
      GROUP BY
        1,
        2,
        3,
        4,
        5,
        6,
        7
    )
  );

END;

CREATE TRIGGER journal_entry_identity_immutable BEFORE
UPDATE OF id ON journal_entry BEGIN
SELECT
  RAISE (ABORT, 'Entry identity is immutable');

END;

CREATE TRIGGER posted_entry_no_update BEFORE
UPDATE ON journal_entry WHEN OLD.status = 'posted' BEGIN
SELECT
  RAISE (
    ABORT,
    'Posted entries are immutable; post a reversal'
  );

END;

CREATE TRIGGER posted_entry_no_delete BEFORE DELETE ON journal_entry WHEN OLD.status = 'posted' BEGIN
SELECT
  RAISE (ABORT, 'Posted entries cannot be deleted');

END;

-- Guard both OLD and NEW parents so a line cannot be moved out of a posted entry.
CREATE TRIGGER posted_line_no_insert BEFORE INSERT ON journal_entry_line WHEN EXISTS (
  SELECT
    1
  FROM
    journal_entry
  WHERE
    id = NEW.entry_id
    AND status = 'posted'
) BEGIN
SELECT
  RAISE (ABORT, 'Posted lines are immutable');

END;

CREATE TRIGGER posted_line_no_update BEFORE
UPDATE ON journal_entry_line WHEN EXISTS (
  SELECT
    1
  FROM
    journal_entry
  WHERE
    status = 'posted'
    AND id IN (OLD.entry_id, NEW.entry_id)
) BEGIN
SELECT
  RAISE (ABORT, 'Posted lines are immutable');

END;

CREATE TRIGGER posted_line_no_delete BEFORE DELETE ON journal_entry_line WHEN EXISTS (
  SELECT
    1
  FROM
    journal_entry
  WHERE
    id = OLD.entry_id
    AND status = 'posted'
) BEGIN
SELECT
  RAISE (ABORT, 'Posted lines are immutable');

END;

-- Master data that posted history depends on.
CREATE TRIGGER administration_currency_frozen BEFORE
UPDATE OF functional_currency ON administration WHEN NEW.functional_currency IS NOT OLD.functional_currency
AND EXISTS (
  SELECT
    1
  FROM
    journal_entry
  WHERE
    status = 'posted'
) BEGIN
SELECT
  RAISE (
    ABORT,
    'Functional currency is fixed once entries are posted'
  );

END;

CREATE TRIGGER ledger_account_semantics_frozen BEFORE
UPDATE OF type,
normal_side,
role,
currency_code ON ledger_account WHEN (
  NEW.type,
  NEW.normal_side,
  NEW.role,
  NEW.currency_code
) IS NOT (
  OLD.type,
  OLD.normal_side,
  OLD.role,
  OLD.currency_code
)
AND EXISTS (
  SELECT
    1
  FROM
    posted_ledger
  WHERE
    ledger_account_id = OLD.id
) BEGIN
SELECT
  RAISE (
    ABORT,
    'Account semantics are fixed once postings exist'
  );

END;

CREATE TRIGGER journal_dimension_set_sealed BEFORE INSERT ON dimension_set_value WHEN EXISTS (
  SELECT
    1
  FROM
    journal_entry_line
  WHERE
    dimension_set_id = NEW.set_id
) BEGIN
SELECT
  RAISE (
    ABORT,
    'Dimension sets are sealed once referenced'
  );

END;

CREATE INDEX journal_entry_period ON journal_entry (accounting_period_id, status);

CREATE INDEX journal_entry_source ON journal_entry (source_document_id);

CREATE INDEX ledger_line_account ON journal_entry_line (ledger_account_id);

CREATE INDEX ledger_line_party ON journal_entry_line (party_account_id)
WHERE
  party_account_id IS NOT NULL;

CREATE INDEX ledger_line_dimension_set ON journal_entry_line (dimension_set_id);
