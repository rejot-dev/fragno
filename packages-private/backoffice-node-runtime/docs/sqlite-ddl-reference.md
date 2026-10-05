# SQLite DDL reference

Reference date: October 4, 2026.

This document inventories every SQLite DDL statement in
`packages-private/backoffice-node-runtime/src`. It distinguishes package-owned production schemas
from consumer-defined and test-only tables. Source code remains authoritative.

## Schema inventory

| Database                      | Runtime                     | Package-owned tables                                                                                                                                                                                 | Package-owned indexes                                                                                                                                                      |
| ----------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graft control database        | Graft runtime control plane | `node_runtime_control_format`, `node_runtime_object_directory`, `node_runtime_object_ownership`, `node_runtime_node_lease`, `node_runtime_control_command_receipt`, `node_runtime_object_alarm_work` | `node_runtime_node_lease_by_expiry`, `node_runtime_object_ownership_by_owner`, `node_runtime_control_command_receipt_by_creation`, `node_runtime_object_alarm_work_by_due` |
| One Graft database per object | Graft object runtime        | `node_runtime_object_identity`, `node_runtime_object_authority`, `node_runtime_values`, `node_runtime_alarm`                                                                                         | None                                                                                                                                                                       |

The package defines no SQLite views or triggers. It currently has no schema migration framework.
Graft databases are provisioned once with a format marker and plain `CREATE TABLE` statements. There
is no separate local SQLite backend or coordination schema.

## 1. Graft control database

**Owner:** `src/graft/graft-control-schema.ts`

**Locator:** the remote log ID returned by `provisionGraftControlDatabase()`

This database stores the control format, stable object-to-log mappings, process-incarnation leases,
object ownership epochs, durable command receipts, and alarm reconciliation/discovery work. The
runtime consumes these decisions during activation and alarm polling, including local scenarios.

### Complete DDL

```sql
CREATE TABLE node_runtime_control_format (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  format INTEGER NOT NULL
) STRICT;

CREATE TABLE node_runtime_object_directory (
  object_id TEXT PRIMARY KEY,
  remote_log_id TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE node_runtime_object_ownership (
  object_id TEXT PRIMARY KEY REFERENCES node_runtime_object_directory(object_id),
  epoch TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('unowned', 'restoring', 'ready')),
  owner_node_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  CHECK (
    (lifecycle = 'unowned' AND owner_node_id = '' AND claim_id = '') OR
    (lifecycle IN ('restoring', 'ready') AND owner_node_id <> '' AND claim_id <> '')
  )
) STRICT;

CREATE TABLE node_runtime_node_lease (
  node_id TEXT PRIMARY KEY,
  process_generation TEXT NOT NULL,
  private_address TEXT NOT NULL,
  application_origin TEXT NOT NULL,
  compatibility_version INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  renewal_id TEXT NOT NULL
) STRICT;

CREATE TABLE node_runtime_control_command_receipt (
  command_id TEXT PRIMARY KEY,
  command_name TEXT NOT NULL,
  command_input_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE node_runtime_object_alarm_work (
  object_id TEXT PRIMARY KEY REFERENCES node_runtime_object_directory(object_id),
  kind TEXT NOT NULL CHECK (kind IN ('reconcile', 'scheduled')),
  reconciliation_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  due_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CHECK (
    (kind = 'reconcile' AND reconciliation_id <> '' AND installation_id = '' AND due_at_ms = 0) OR
    (kind = 'scheduled' AND reconciliation_id = '' AND installation_id <> '')
  )
) STRICT;

CREATE INDEX node_runtime_node_lease_by_expiry
ON node_runtime_node_lease (expires_at_ms, node_id);

CREATE INDEX node_runtime_object_ownership_by_owner
ON node_runtime_object_ownership (owner_node_id, object_id);

CREATE INDEX node_runtime_control_command_receipt_by_creation
ON node_runtime_control_command_receipt (created_at_ms, command_id);

CREATE INDEX node_runtime_object_alarm_work_by_due
ON node_runtime_object_alarm_work (kind, due_at_ms, object_id);
```

Provisioning inserts this format row:

```sql
INSERT INTO node_runtime_control_format (singleton, format)
VALUES (1, 4);
```

The insert is data rather than DDL, but it is part of the schema compatibility contract. Runtime
startup refuses a control database whose singleton format is not `4`.

### `node_runtime_control_format`

A one-row persisted format marker.

| Column      | Meaning                                            |
| ----------- | -------------------------------------------------- |
| `singleton` | Must be `1`; prevents multiple active format rows. |
| `format`    | Current control schema format, exactly `4`.        |

There is no in-place upgrade path yet. A format change must add an explicit migration or provision a
new control database and migration procedure.

### `node_runtime_object_directory`

Stable identity-to-storage mapping used by the distributed control commands.

| Column          | Meaning                                                |
| --------------- | ------------------------------------------------------ |
| `object_id`     | Canonical `${binding}:${name}` object identity.        |
| `remote_log_id` | Opaque Graft remote log ID for that object's database. |

Both values are unique. An object is first provisioned and pushed to its own Graft log, then this
mapping is inserted and the control database is pushed. A failure after object provisioning but
before directory durability may leave an unreferenced remote log; the runtime never substitutes it
for a different object's mapping.

### `node_runtime_object_ownership`

The current durable owner and monotonically increasing fencing epoch for each directory row.

| Column          | Meaning                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| `object_id`     | Primary key and foreign key to the stable object directory row.                        |
| `epoch`         | Non-negative decimal string, bounded to signed 64-bit range and incremented on claims. |
| `lifecycle`     | Exactly `unowned`, `restoring`, or `ready`.                                            |
| `owner_node_id` | Owning process-incarnation node ID; empty only while `unowned`.                        |
| `claim_id`      | Identity of the exact claim; empty only while `unowned`.                               |

The table constraint makes owner and claim identity mandatory for owned variants and absent for the
unowned variant. Releasing ownership preserves `epoch`; a later claim advances it. A control claim
may replace an owned row only when the previous node lease is absent or expired in the same control
snapshot.

### `node_runtime_node_lease`

One renewable authority record per process incarnation.

| Column                  | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `node_id`               | Unique process-incarnation identity.                             |
| `process_generation`    | Additional generation checked by renewal and ownership commands. |
| `private_address`       | Advertised peer-routing address.                                 |
| `application_origin`    | Validated HTTP origin used for gateway application delivery.     |
| `compatibility_version` | Runtime protocol compatibility version.                          |
| `expires_at_ms`         | Wall-clock epoch-millisecond authority deadline.                 |
| `renewal_id`            | Last confirmed renewal identity required by the next renewal.    |

`node_runtime_node_lease_by_expiry` supports takeover and alarm-work serviceability decisions. The
control store also performs exact node lookups for command preconditions, authority renewal, and
peer routing.

### `node_runtime_control_command_receipt`

Durable idempotency and uncertainty-reconciliation record written in the same local SQLite
transaction as each control decision.

| Column               | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `command_id`         | Globally unique logical command identity.                                       |
| `command_name`       | Named operation such as `claim-object` or `renew-node-lease`.                   |
| `command_input_json` | Canonical normalized input used to reject command-ID reuse with different data. |
| `result_json`        | Exact command outcome returned after remote durability is confirmed.            |
| `created_at_ms`      | Caller-supplied command creation time for bounded future receipt retention.     |

After a failed push response, `GraftControlStore` discards the speculative branch and opens a fresh
clone. A matching receipt proves the prior result. If no receipt is visible, the store reruns the
named semantic command with the same identity and current preconditions. It never replays raw SQL
from the losing branch. `node_runtime_control_command_receipt_by_creation` supports future bounded
receipt collection; collection is not implemented yet.

### `node_runtime_object_alarm_work`

One durable discovery or repair row per object with a current alarm-related obligation.

| Column              | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `object_id`         | Primary key and foreign key to the canonical object directory.         |
| `kind`              | Exactly `reconcile` or `scheduled`.                                    |
| `reconciliation_id` | Exact repair marker; nonempty only for `reconcile`.                    |
| `installation_id`   | Exact alarm installation UUID; nonempty only for `scheduled`.          |
| `due_at_ms`         | Alarm due time for `scheduled`; exactly `0` for `reconcile`.           |
| `created_at_ms`     | Creation time of the command that produced the current work-row state. |

Before changing an authority-bound object alarm, the worker durably replaces this row with an exact
`reconcile` marker. After pushing the object database, it conditionally converts that marker to
`scheduled` or removes it when no alarm remains. Activation and periodic polling repair unfinished
markers from the authoritative object database. `node_runtime_object_alarm_work_by_due` supports
bounded object-ID cursor scans filtered by due time; reconciliation rows are always eligible.

### Graft connection settings

Graft databases use:

```sql
PRAGMA journal_mode = MEMORY;
PRAGMA foreign_keys = ON;
```

WAL is deliberately not used with the Graft VFS. `graft_clone`, `graft_pull`, `graft_push`, and
`graft_info` are Graft management PRAGMAs, not schema DDL.

## 2. Per-object Graft database

**Owners:** `src/graft/graft-object-provisioning.ts`, `src/graft/graft-object-authority.ts`

**Cardinality:** one remote Graft log per canonical object identity

Each database contains package-owned runtime tables and consumer-defined application/Fragment
tables. Because the database itself is object-scoped, its runtime KV and alarm tables do not repeat
an `object_id` column.

### Complete package-owned DDL

```sql
CREATE TABLE node_runtime_object_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  object_id TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE node_runtime_object_authority (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  object_id TEXT NOT NULL UNIQUE REFERENCES node_runtime_object_identity(object_id),
  epoch TEXT NOT NULL,
  owner_node_id TEXT NOT NULL,
  process_generation TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  CHECK (
    (epoch = '0' AND owner_node_id = '' AND process_generation = '' AND claim_id = '') OR
    (epoch <> '0' AND owner_node_id <> '' AND process_generation <> '' AND claim_id <> '')
  )
) STRICT;

CREATE TABLE node_runtime_values (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
) STRICT;

CREATE TABLE node_runtime_alarm (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  timestamp INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  installation_id TEXT NOT NULL UNIQUE
) STRICT;
```

Provisioning also records the database's identity:

```sql
INSERT INTO node_runtime_object_identity (singleton, object_id)
VALUES (1, ?);

INSERT INTO node_runtime_object_authority
  (singleton, object_id, epoch, owner_node_id, process_generation, claim_id)
VALUES (1, ?, '0', '', '', '');
```

The worker verifies the identity after cloning and refuses to activate a database mapped to a
different object identity. The initial authority row is unfenced at epoch `0` until the first
authority-bound activation pushes its claim.

### `node_runtime_object_identity`

A one-row binding between the remote log and its canonical runtime object.

| Column      | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `singleton` | Must be `1`.                                                           |
| `object_id` | Canonical object identity; unique even though only one row is allowed. |

### `node_runtime_object_authority`

The exact object-log writer generation installed by an authority-bound activation.

| Column               | Meaning                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `singleton`          | Must be `1`, enforcing one current storage fence.                 |
| `object_id`          | Foreign key to this database's canonical object identity.         |
| `epoch`              | Monotonic decimal-string control epoch; `0` means not fenced yet. |
| `owner_node_id`      | Process-incarnation node ID; empty only at epoch `0`.             |
| `process_generation` | Exact process generation; empty only at epoch `0`.                |
| `claim_id`           | Exact durable control claim; empty only at epoch `0`.             |

After a control claim enters `restoring`, activation clones the stable object log and pushes this
row with the new epoch. A competing old append that lands first is incorporated before fencing is
retried. Once the fence lands first, an old clone diverges instead of extending the successor's
history. Application SQL rejects every `node_runtime_` table name, keeping this row runtime-owned.

### `node_runtime_values`

The Graft runtime's narrow `DurableObjectStorage` compatibility table.

| Column  | Meaning                                  |
| ------- | ---------------------------------------- |
| `key`   | Object-local string key and primary key. |
| `value` | `node:v8` serialized value.              |

Every mutation commits through the worker-owned object connection and marks the activation dirty.
Before the worker returns the enclosing object event result or handler error, it synchronously runs
`graft_push`. A push failure poisons the managed database so the rejected or uncertain local branch
cannot be read as confirmed state.

### `node_runtime_alarm`

The current object-local alarm installation. Absence means no alarm.

| Column            | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `singleton`       | Must be `1`, enforcing at most one current alarm.              |
| `timestamp`       | Integer epoch milliseconds.                                    |
| `generation`      | Local diagnostic generation incremented while the row exists.  |
| `installation_id` | Fresh UUID identifying this exact installation across re-arms. |

Authority-bound alarm mutations install a control reconciliation marker before changing this row,
then immediately push the object database and publish the resulting discovery state. Successful
delivery deletes only the exact `installation_id`; a handler re-arm therefore survives completion of
the older alarm.

## 3. Consumer-defined object database DDL

`state.storage.sql` exposes synchronous object-owned application SQL without transaction, commit,
flush, or push controls. The package does not prescribe consumer table names or columns.

```ts
state.storage.sql.exec(
  `CREATE TABLE example_records (
     id TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,
);
```

The managed boundary currently permits top-level `CREATE`, `ALTER`, and `DROP` statements.
Transaction-control statements, `PRAGMA`, `ATTACH`, and references to reserved `node_runtime_`
tables are rejected. SQLite commits locally during `exec`; after the enclosing object event settles,
the worker pushes before exposing its result or handler error.

Consumer DDL shares each object's Graft database with the four runtime tables above.

## 4. Test-only DDL

These tables appear under `src/testing` or colocated tests. They verify the managed database but are
not runtime schema contracts.

### `graft_counter`

**Source:** `src/testing/fixtures/graft-runtime.objects.ts`

```sql
CREATE TABLE IF NOT EXISTS graft_counter (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  count INTEGER NOT NULL
) STRICT;
```

This verifies that consumer SQL and runtime KV state recover together from an empty container cache.

### `conflict_events`

**Source:** `src/testing/fixtures/graft-conflict-process.ts`

```sql
CREATE TABLE conflict_events (
  writer TEXT PRIMARY KEY
) STRICT;
```

Two independent clones insert distinct writers from the same remote head. Exactly one push wins; a
fresh clone contains only that writer, while the losing clone retains its speculative row and
reports divergence.

### `rejected_write`

**Source:** `src/sqlite/managed-node-runtime-object-database.test.ts`

```sql
CREATE TABLE rejected_write (
  value INTEGER NOT NULL
);
```

This statement runs inside an intentionally invalid asynchronous internal database callback. The
worker-owned managed boundary rolls the transaction back, so the table must not exist afterward.

### `read_boundary`

**Source:** `src/sqlite/managed-node-runtime-object-database.test.ts`

```sql
CREATE TABLE read_boundary (
  value INTEGER NOT NULL
);
```

This verifies that the internal read boundary rejects mutations and leaves the table empty.

### `node_runtime_fake`

**Source:** `src/sqlite/managed-node-runtime-object-database.test.ts`

```sql
CREATE TABLE node_runtime_fake (
  value INTEGER NOT NULL
);
```

This statement is intentionally rejected at the object-author SQL boundary. It verifies that
consumer DDL cannot create or modify tables in the runtime-reserved `node_runtime_` namespace.

## 5. Schema relationships

```text
Graft control database

node_runtime_control_format (singleton = 1)
node_runtime_object_directory (object_id, remote_log_id)
  ├── node_runtime_object_ownership (object_id, epoch, lifecycle, owner_node_id, claim_id)
  └── node_runtime_object_alarm_work
      (object_id, kind, reconciliation_id, installation_id, due_at_ms)
node_runtime_node_lease
  (node_id, process_generation, private_address, application_origin, expires_at_ms, renewal_id)
node_runtime_control_command_receipt (command_id, command_name, result_json)

object_id ─────────────────► opaque remote_log_id

One Graft object database per directory row

node_runtime_object_identity (singleton = 1, object_id)
  └── node_runtime_object_authority
      (singleton = 1, object_id, epoch, owner_node_id, process_generation, claim_id)
node_runtime_values (key)
node_runtime_alarm (singleton = 1, installation_id)
consumer-defined application/Fragment tables
```

There is no SQLite foreign key between the control database and object databases because they are
separate Graft logs. The directory mapping and the object's identity row establish that relationship
at runtime. Activation validates that the control claim and object authority row carry the same
object, epoch, node, and claim before publishing readiness.

## 6. Maintenance checklist

When changing package-owned DDL:

1. Update the defining source and this reference together.
2. Decide whether existing databases need migration; `CREATE IF NOT EXISTS` does not alter existing
   columns, constraints, or indexes.
3. Advance `node_runtime_control_format` when a control database reader cannot safely interpret the
   previous shape, and implement the corresponding migration or replacement procedure.
4. Preserve `STRICT` tables unless a concrete compatibility requirement says otherwise.
5. Keep epoch milliseconds and local alarm generations as integers; installation identities remain
   opaque nonempty strings.
6. Preserve V8 serialization compatibility or provide an explicit data migration.
7. Add a fresh-database test and a restart/clone test for persistent changes.
8. For Graft schemas, assert recovery after deleting the complete local cache.
9. Re-run the source inventory:

   ```sh
   rg -n -i '\b(create|alter|drop)\s+(table|index|trigger|view)' \
     packages-private/backoffice-node-runtime/src
   ```

10. Keep test-only DDL identified as such; do not treat fixture tables as public runtime schema.
