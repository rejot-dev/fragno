# SQLite DDL reference

Reference date: October 1, 2026.

This document inventories every SQLite DDL statement in
`packages-private/backoffice-node-runtime/src`. It distinguishes package-owned production schemas
from consumer-defined and test-only tables. Source code remains authoritative.

## Schema inventory

| Database                                  | Runtime                    | Package-owned tables                                                               | Package-owned indexes |
| ----------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------- | --------------------- |
| `objects.sqlite`                          | Local file-backed runtime  | `object_instances`, `object_values`, `object_alarms`, `object_coordination_claims` | `object_alarms_due`   |
| Graft control database                    | Single-owner Graft runtime | `node_runtime_control_format`, `node_runtime_object_directory`                     | None                  |
| One Graft database per object             | Single-owner Graft runtime | `node_runtime_object_identity`, `node_runtime_values`, `node_runtime_alarm`        | None                  |
| One local managed SQL database per object | Local file-backed runtime  | None                                                                               | None                  |

The package defines no SQLite views or triggers. It currently has no schema migration framework.
Local runtime tables use `CREATE ... IF NOT EXISTS`; Graft databases are provisioned once with a
format marker and plain `CREATE TABLE` statements.

## 1. Local runtime coordination database

**Owner:** `src/sqlite/sqlite-object-storage.ts`

**File:** `<runtime directory>/objects.sqlite`

This database multiplexes every local object identity into one SQLite file. It is used by
`createNodeObjectRuntime`, not by `createGraftNodeObjectRuntime`. Foreign keys are enabled, so
removing an `object_instances` row cascades to its values, alarm, and claims.

### Complete DDL

```sql
CREATE TABLE IF NOT EXISTS object_instances (
  object_id TEXT PRIMARY KEY,
  alarm_generation INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS object_values (
  object_id TEXT NOT NULL REFERENCES object_instances(object_id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (object_id, key)
) STRICT;

CREATE TABLE IF NOT EXISTS object_alarms (
  object_id TEXT PRIMARY KEY REFERENCES object_instances(object_id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,
  generation INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS object_alarms_due
ON object_alarms(timestamp, object_id);

CREATE TABLE IF NOT EXISTS object_coordination_claims (
  object_id TEXT NOT NULL REFERENCES object_instances(object_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('initialization', 'alarm')),
  owner_id TEXT NOT NULL,
  token INTEGER NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (object_id, kind)
) STRICT;
```

### `object_instances`

One row establishes a persistent local object identity.

| Column             | Meaning                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `object_id`        | Canonical `${binding}:${name}` identity. Binding names cannot contain `:`; object names may. |
| `alarm_generation` | Monotonic local generation assigned whenever the current alarm is replaced or deleted.       |

`registerObject()` inserts this row with `INSERT OR IGNORE`. The runtime lists this table to
rediscover local objects before alarm processing.

### `object_values`

The local `DurableObjectStorage` compatibility key/value table.

| Column      | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `object_id` | Owning local object. Cascades when its `object_instances` row is deleted.                  |
| `key`       | Object-local string key.                                                                   |
| `value`     | `node:v8` serialized value. This is not JSON and is independent of Cap'n Web RPC encoding. |

The composite primary key enforces one value per object/key pair. Prefix listing is currently
implemented by reading an object's ordered keys and filtering in JavaScript; there is no prefix
index beyond the primary key.

### `object_alarms`

The authoritative current local alarm installation. Absence means no alarm.

| Column       | Meaning                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `object_id`  | Owning object and the one-row-per-object primary key.                  |
| `timestamp`  | Integer epoch milliseconds at which the alarm becomes due.             |
| `generation` | Installation identity copied from `object_instances.alarm_generation`. |

`object_alarms_due(timestamp, object_id)` supports globally ordered due-alarm scans. The current
runtime normally reads alarms per object, but this index preserves the direct due-scan access path.
An alarm handler deletes only the generation it delivered, so a concurrent replacement survives.

### `object_coordination_claims`

Short-lived local claims for initialization and alarm delivery. These claims do not authorize
ordinary object events or implement distributed object ownership.

| Column       | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| `object_id`  | Object whose narrow operation is claimed.                    |
| `kind`       | Exactly `initialization` or `alarm`.                         |
| `owner_id`   | Process claim owner, currently `${pid}:${random UUID}`.      |
| `token`      | Increasing fencing token for this object/kind row.           |
| `active`     | Integer boolean constrained to `0` or `1`.                   |
| `expires_at` | Epoch milliseconds generated and compared using SQLite time. |

The `(object_id, kind)` primary key allows at most one current claim of each kind. Reacquisition
increments `token`; an expired token cannot be renewed. Claimed writes validate the token, active
state, and expiry inside the same SQLite transaction as the mutation.

### Connection settings

These are PRAGMAs, not DDL, but they define the local schema's execution environment:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
```

They are applied by `src/sqlite/sqlite-connection-config.ts`.

## 2. Graft control database

**Owner:** `src/graft/graft-object-directory.ts`

**Locator:** the remote log ID returned by `provisionGraftControlDatabase()`

This database is the first control-plane slice. It stores only the control format and stable object
to remote-log mappings. It does **not** yet contain node leases, ownership epochs, routing metadata,
command receipts, or alarm discovery state.

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
```

Provisioning inserts this format row:

```sql
INSERT INTO node_runtime_control_format (singleton, format)
VALUES (1, 1);
```

The insert is data rather than DDL, but it is part of the schema compatibility contract. Runtime
startup refuses a control database whose singleton format is not `1`.

### `node_runtime_control_format`

A one-row persisted format marker.

| Column      | Meaning                                            |
| ----------- | -------------------------------------------------- |
| `singleton` | Must be `1`; prevents multiple active format rows. |
| `format`    | Current control schema format, exactly `1`.        |

There is no in-place upgrade path yet. A format change must add an explicit migration or provision a
new control database and migration procedure.

### `node_runtime_object_directory`

Stable identity-to-storage mapping for the single-owner Graft runtime.

| Column          | Meaning                                                |
| --------------- | ------------------------------------------------------ |
| `object_id`     | Canonical `${binding}:${name}` object identity.        |
| `remote_log_id` | Opaque Graft remote log ID for that object's database. |

Both values are unique. An object is first provisioned and pushed to its own Graft log, then this
mapping is inserted and the control database is pushed. A failure after object provisioning but
before directory durability may leave an unreferenced remote log; the runtime never substitutes it
for a different object's mapping.

### Graft connection settings

Graft databases use:

```sql
PRAGMA journal_mode = MEMORY;
PRAGMA foreign_keys = ON;
```

WAL is deliberately not used with the Graft VFS. `graft_clone`, `graft_pull`, `graft_push`, and
`graft_info` are Graft management PRAGMAs, not schema DDL.

## 3. Per-object Graft database

**Owner:** `src/graft/graft-object-directory.ts`

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

CREATE TABLE node_runtime_values (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
) STRICT;

CREATE TABLE node_runtime_alarm (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  timestamp INTEGER NOT NULL,
  generation INTEGER NOT NULL
) STRICT;
```

Provisioning also records the database's identity:

```sql
INSERT INTO node_runtime_object_identity (singleton, object_id)
VALUES (1, ?);
```

The worker verifies this row after cloning and refuses to activate a database mapped to a different
object identity.

### `node_runtime_object_identity`

A one-row binding between the remote log and its canonical runtime object.

| Column      | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `singleton` | Must be `1`.                                                           |
| `object_id` | Canonical object identity; unique even though only one row is allowed. |

This is an identity check, not yet an ownership fence. Future distributed ownership work will need
an epoch/incarnation authority record or equivalent fencing protocol.

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

| Column       | Meaning                                             |
| ------------ | --------------------------------------------------- |
| `singleton`  | Must be `1`, enforcing at most one current alarm.   |
| `timestamp`  | Integer epoch milliseconds.                         |
| `generation` | Incremented when an alarm is installed or replaced. |

A successful handler deletes only the generation it received. The implemented single-owner slice
persists this row with the object, but it does not yet publish a fleet-wide alarm discovery index.
Consequently, this is durable alarm state without the distributed wake-up protocol described in
`stateless-graft-runtime-plan.md`.

## 4. Consumer-defined object database DDL

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
Transaction-control statements, `PRAGMA`, and `ATTACH` are rejected. SQLite commits locally during
`exec`; after the enclosing object event settles, the worker pushes before exposing its result or
handler error.

For `createNodeObjectRuntime`, each object receives a regular managed SQLite database named from the
base64url-encoded canonical object identity. The package creates no tables in it automatically. For
`createGraftNodeObjectRuntime`, consumer DDL shares the object database with the three runtime
tables above.

## 5. Test-only DDL

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

## 6. Schema relationships

```text
Local runtime: objects.sqlite

object_instances (object_id)
  ├── object_values (object_id, key)          ON DELETE CASCADE
  ├── object_alarms (object_id)               ON DELETE CASCADE
  └── object_coordination_claims
      (object_id, kind)                       ON DELETE CASCADE

Graft control database

node_runtime_control_format (singleton = 1)
node_runtime_object_directory
  object_id ───────────────► opaque remote_log_id

One Graft object database per directory row

node_runtime_object_identity (singleton = 1, object_id)
node_runtime_values (key)
node_runtime_alarm (singleton = 1)
consumer-defined application/Fragment tables
```

There is no SQLite foreign key between the control database and object databases because they are
separate Graft logs. The directory mapping and the object's identity row establish that relationship
at runtime.

## 7. Maintenance checklist

When changing package-owned DDL:

1. Update the defining source and this reference together.
2. Decide whether existing databases need migration; `CREATE IF NOT EXISTS` does not alter existing
   columns, constraints, or indexes.
3. Advance `node_runtime_control_format` when a control database reader cannot safely interpret the
   previous shape, and implement the corresponding migration or replacement procedure.
4. Preserve `STRICT` tables unless a concrete compatibility requirement says otherwise.
5. Keep epoch milliseconds and alarm generations as integers.
6. Preserve V8 serialization compatibility or provide an explicit data migration.
7. Add a fresh-database test and a restart/clone test for persistent changes.
8. For Graft schemas, assert recovery after deleting the complete local cache.
9. Re-run the source inventory:

   ```sh
   rg -n -i '\b(create|alter|drop)\s+(table|index|trigger|view)' \
     packages-private/backoffice-node-runtime/src
   ```

10. Keep test-only DDL identified as such; do not treat fixture tables as public runtime schema.
