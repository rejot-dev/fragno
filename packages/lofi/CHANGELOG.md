# @fragno-dev/lofi

## 0.1.0

### Minor Changes

- 187d67e: feat: replace bare outbox streaming with protocol-1 frames and migrate built-in
  consumers.

### Patch Changes

- 2797663: perf: use fixed 50-entry, versionstamp-aligned outbox catch-up pages, bound stream
  snapshot retention, and align Lofi with the canonical outbox page size.
- d2da73f: feat: add atomic bulk deletes with optimistic concurrency and bounded SQL statements.
- 9c894a8: feat bootstrap Lofi runtimes before running reactive queries.
- c1314be: feat: schemas can drop a table with `dropTable()`. Its migration drops the table only if
  it exists, so a schema can restore an `addTable()` an earlier release replaced with `noOp()` and
  drop it. Lofi skips the outbox rows of tables a registered schema dropped instead of failing on
  them.
- d9a5ffe: fix: include db-now defaults in create outbox payloads.
- 83bea0b: feat: `alterTable()` can rename columns (`renameColumn`) and drop indexes (`dropIndex`),
  keeping the table's rows. Lofi keys its IndexedDB indexes by the schema's current indexes.
- 20380f5: feat add scenario bootstrap steps and SSR-style deferred store mounting.
- 65ab8ab: feat: add `onStopped` to `LofiClient`, called when an error ends synchronization.
- 882ef4d: feat!: guarded SQL views refuse only what could break the leader: writes, transaction
  statements, `ATTACH`/`DETACH`, and setting a pragma; `random()`, read pragmas, and any number of
  rows now work. Migrate: replace `limits` with `operations` (thousands of operations per run);
  results no longer carry `truncated`, and `LofiSqliteGuard` no longer takes `maxLength`.
- cd7cfc9: feat: add local schemas and transactional projections.
- b83dfa6: feat: `LofiClient` applies the outbox entries that have arrived in batches through the
  new required `LofiAdapter.applyOutboxBatch`, and `onSyncApplied` and `onSyncComplete` run once per
  batch. The SQLite replica commits each batch, and its cursor, in one transaction; a failing entry
  rolls back its batch. Custom adapters implement `applyOutboxBatch(apply)` as `apply(this)` to keep
  committing each entry on its own.
- dfeb582: feat: add multi-query stores and UOW mutation projection helpers.
- d961df2: feat add reactive Lofi runtimes and query stores, and export the workflow schema
  entrypoint.
- eaf1adb: feat!: the SQLite replica worker serves only the view engines it is given;
  `replica.sql()` and the built-in `"sql"` view kind are gone. Migrate: name each query as a read,
  `(reader) => reader.query({ sql, params, columns })`, serve it with
  `readViewEngine({ kind, reads })` in the worker's `engines`, and open it on the page with
  `lofiSqliteReadViews<typeof reads>(kind)(replica, name, args)`.
- a997288: feat: report catch-up progress from `LofiClient` streams with `onCatchUp`, and expose a
  SQLite replica's download progress and `caught-up` state, shared across tabs, with `getStatus` and
  `subscribeStatus`.
- 83e7876: feat: add typed runtime retrieve transactions and store builders.
- 54cbdca: fix: resolve registered schema names consistently in Lofi adapters.
- 0e32b6a: feat: the SQLite replica skips entries up to the last versionstamp it applied instead of
  recording each entry in a `lofi_inbox` table. `LOFI_SQLITE_LAYOUT_VERSION` is now 2, so existing
  replicas replay the outbox into a new database.
- b9a5ffd: feat: the SQLite replica runs only in replica workers, through
  `@fragno-dev/lofi/sqlite/worker`, and needs `@journeyapps/wa-sqlite` 2.x, whose OPFS VFS no longer
  races other workers at startup. lofi no longer depends on
  `@tanstack/browser-db-sqlite-persistence`.

  fix: the synchronous connection that replica workers' views read through returns text as it was
  stored: a NUL no longer ends it, and a leading byte order mark is kept.

- da2b63f: feat: refresh replica views by the tables a batch wrote, and add guarded SQL views. The
  replica records the tables each batch writes and passes them to `replica.subscribe` listeners as
  `{ tables }`, and engines' `refresh(changed)`; SQL and read views run again only after batches
  that wrote a table they read, which statements report as `statement.tables`. The synchronous
  connection prepares one statement at a time and adds `guarded(guard, run)`, which authorizes what
  statements read and limits their work and string length. `guardedSqlViewEngine` maintains views of
  SQL that people or agents write over its views and derived relations: they cannot write or call
  functions whose result changes on their own, and stop at row, byte, and operation limits.
  `quoteSqliteIdentifier` is exported, to build SQL over the replica's table names.
- 360641f: fix: a closing SQLite replica host now waits for its replica before closing its channels,
  so a status the replica reports while closing no longer throws "BroadcastChannel is closed".
- 4ac6786: feat: add `query` to the SQLite replica, which decodes each result column like the schema
  column it names, or as a plain integer or text.
- b5b0b7f: feat: add read views to the SQLite replica worker. `readViewEngine` runs named read
  functions, which may run several queries, on the leading tab's connection with the database
  locked, again after every batch, and sends a view's result only when it changed; pages open them
  with `lofiSqliteReadViews`.
- 770658d: feat: rebuild SQLite replica projections from stored rows. A projection that declares
  `rebuild` (its version, the source tables it replays, and the local tables it alone writes) no
  longer names the replica's database. When its version or its tables change, the replica drops and
  recreates its tables and runs it on the stored source rows, in the order the outbox delivered
  them, instead of downloading the outbox again. `rebuildLofiSqliteProjections` in
  `@fragno-dev/lofi/sqlite/testing` checks that a projection rebuilds to the rows the outbox built.
- 377cece: fix: give a SQLite replica's rows written before a column was added the column's fixed
  default, as the backend's migration gave them, instead of NULL. Replica tables now declare regular
  columns' fixed defaults, and `LOFI_SQLITE_LAYOUT_VERSION` is 3, so existing replicas download
  again.
- bc71caa: feat: add `@fragno-dev/lofi/sqlite`, a browser SQLite (OPFS) replica of a backend's
  outbox with the backend's table layout, local projections, and one writing tab elected with a Web
  Lock.
- 6da3e68: feat: add `createLofiSqliteTableStatements`, the statements that create a replica's
  tables, empty, for checking queries on a server.
- c4e555d: feat: add `@fragno-dev/lofi/sqlite/testing` to open SQLite replicas in Node on
  wa-sqlite's in-memory VFS and wait until they reach a versionstamp, for scenario tests of apps
  that read a replica.
- 9b8d042: fix: report a SQL or read view that fails to refresh to its page instead of keeping its
  old data as ready, and report it again once it recovers. An engine that fails to refresh no longer
  stops the others, and gets its changed tables again with the next batch. A view engine's
  `materialize` now takes `fail`, which reports a failed run. A SQL or read view whose first run
  fails is kept, runs again after later batches, and reports its data once it succeeds, instead of
  failing until the page asks for it again.

  fix: a replica worker that fails to open the replica, for example on a failed `GET /_internal`,
  tries again after `retryDelayMs` instead of giving up, so a brief outage while the leading tab
  closes no longer leaves every tab without a leader. Pages connect meanwhile, with the error in
  their status. Only a backend replaced since the page loaded still rejects `connectLofiSqlite`.

  feat: a replica's new `adapterIdentity` option names the backend the page expects. Tabs share a
  leader only with tabs that expect the same backend, and the replica refuses to open on a backend
  that reports another identity.

- fc794d7: fix: `starts with` and `not starts with` match case, as they now do on the server.
- b702d0f: feat: `@fragno-dev/lofi/sqlite/worker` runs the SQLite replica in a dedicated worker per
  tab, where one leading tab opens the replica and maintains every tab's live views; pages connect
  with `connectLofiSqlite` and read live SQL views. The new `@fragno-dev/lofi-zql` package adds a
  view engine that keeps ZQL query results up to date incrementally as outbox entries arrive,
  reading rows from SQLite on demand instead of holding the tables in memory
- f297b5d: feat: add streaming outbox transport for Lofi clients.
- 8e31918: feat: add recoverable ephemeral outbox streams and reactive store overlays.
- 9919fdd: feat: add schema-bound FragnoDatabase APIs and explicit unit-of-work query flows.
- Updated dependencies [0d4cbe8]
- Updated dependencies [2797663]
- Updated dependencies [fcecfed]
- Updated dependencies [d2da73f]
- Updated dependencies [cff3b99]
- Updated dependencies [fcd0179]
- Updated dependencies [4db850e]
- Updated dependencies [766f977]
- Updated dependencies [27b7db5]
- Updated dependencies [9419f78]
- Updated dependencies [73e14d7]
- Updated dependencies [a8010b8]
- Updated dependencies [26a21e3]
- Updated dependencies [eb6ea3e]
- Updated dependencies [71b0233]
- Updated dependencies [0186a7a]
- Updated dependencies [4fd5010]
- Updated dependencies [2ab64f4]
- Updated dependencies [3f9d1bb]
- Updated dependencies [867bc9d]
- Updated dependencies [8b651fe]
- Updated dependencies [b79e697]
- Updated dependencies [c1314be]
- Updated dependencies [767c934]
- Updated dependencies [b854e42]
- Updated dependencies [c13b6c7]
- Updated dependencies [e6d80bb]
- Updated dependencies [d9a5ffe]
- Updated dependencies [a15bcc2]
- Updated dependencies [719ac3b]
- Updated dependencies [d1b4bd9]
- Updated dependencies [83bea0b]
- Updated dependencies [9a01df4]
- Updated dependencies [d92f4ce]
- Updated dependencies [1d2125e]
- Updated dependencies [fc794d7]
- Updated dependencies [0cf8414]
- Updated dependencies [fe0e92d]
- Updated dependencies [20324e7]
- Updated dependencies [6b028b6]
- Updated dependencies [c1255e4]
- Updated dependencies [318921d]
- Updated dependencies [92adef0]
- Updated dependencies [7e2d989]
- Updated dependencies [d62cc57]
- Updated dependencies [ae415ff]
- Updated dependencies [204bbb7]
- Updated dependencies [8a60280]
- Updated dependencies [2b8f4b7]
- Updated dependencies [a7bf719]
- Updated dependencies [9ea7170]
- Updated dependencies [187d67e]
- Updated dependencies [aff91d1]
- Updated dependencies [03d5a5c]
- Updated dependencies [a28094e]
- Updated dependencies [b4fc242]
- Updated dependencies [033a643]
- Updated dependencies [c41c1e2]
- Updated dependencies [bfe589e]
- Updated dependencies [6cc8f36]
- Updated dependencies [f42c8c6]
- Updated dependencies [9cd79f3]
- Updated dependencies [7a625f6]
- Updated dependencies [d689267]
- Updated dependencies [49ca4fb]
- Updated dependencies [0e63275]
- Updated dependencies [4944ecf]
- Updated dependencies [d9ac2a3]
- Updated dependencies [4e5d611]
- Updated dependencies [2dbc550]
- Updated dependencies [2dbc550]
- Updated dependencies [7405040]
- Updated dependencies [04fac88]
- Updated dependencies [b40a129]
- Updated dependencies [5256cee]
- Updated dependencies [6c0de3b]
- Updated dependencies [f297b5d]
- Updated dependencies [caf581b]
- Updated dependencies [02e29d4]
- Updated dependencies [7de0078]
- Updated dependencies [ff3673f]
- Updated dependencies [d7236a2]
- Updated dependencies [1e1088b]
- Updated dependencies [9e2ee05]
- Updated dependencies [3734573]
- Updated dependencies [1c57f29]
- Updated dependencies [2e7263b]
- Updated dependencies [801e6ab]
- Updated dependencies [f510d32]
- Updated dependencies [48c0094]
- Updated dependencies [7a60491]
- Updated dependencies [6649e1f]
- Updated dependencies [3570c2a]
- Updated dependencies [d125074]
- Updated dependencies [8afaf3d]
- Updated dependencies [2d729a4]
- Updated dependencies [85be413]
- Updated dependencies [fa21507]
- Updated dependencies [79055dd]
- Updated dependencies [e7b36e1]
- Updated dependencies [a61b3a5]
- Updated dependencies [4dc14bf]
- Updated dependencies [3328fe3]
- Updated dependencies [a64dc64]
- Updated dependencies [ea8ea88]
- Updated dependencies [5599183]
- Updated dependencies [e2cad8d]
- Updated dependencies [93bc657]
- Updated dependencies [5e0cfe8]
- Updated dependencies [9919fdd]
  - @fragno-dev/db@0.5.0
  - @fragno-dev/core@0.2.3
  - @fragno-dev/node@0.0.9

## 0.0.3

### Patch Changes

- Updated dependencies [0020e39]
  - @fragno-dev/core@0.2.2
  - @fragno-dev/db@0.4.1
  - @fragno-dev/node@0.0.9

## 0.0.2

### Patch Changes

- 5b05bd1: feat: add lofi submit client and local handler tx helpers
- 4d141f8: fix: remove development exports from published packages
- cbe9667: feat: add outbox decoding and mutation transform utilities
- d2f68ba: feat: add db now offsets and interval helpers
- 65fdf11: fix: require client schema module for the lofi CLI
- 257f14e: feat: add lofi cli serve/client/scenario commands and scenario DSL export
- 2c650fc: fix(lofi): avoid double-applying confirmed optimistic updates
- 9812530: feat(lofi): add in-memory lofi adapter for optimistic overlay
- 7fe3470: fix: dedupe outbox entries by uow+versionstamp
- 3aac02e: feat(lofi): add IndexedDB adapter for local-first client
- f43536c: feat(lofi): add IndexedDB base snapshot export for overlays
- bcf8a45: feat: add overlay manager to rebuild optimistic state from base + queue
- 7a2c69d: feat(lofi): add initial lofi package scaffold
- 2488521: feat: add IndexedDB query engine with local filtering, joins, and cursors
- e69b2f8: fix(lofi): remove IndexedDbAdapter base snapshot export APIs
- 24526b9: feat: add stacked adapter that merges base and optimistic overlay reads
- ed22f3f: fix: route optimistic execution through stacked adapter
- 26d8174: feat(lofi): add onSyncApplied hook for LofiClient
- c03602c: feat: support stacked adapter scenarios with indexeddb injection
- Updated dependencies [8a96998]
- Updated dependencies [3e2ff94]
- Updated dependencies [f34d7d7]
- Updated dependencies [4d141f8]
- Updated dependencies [c8841b5]
- Updated dependencies [83f6223]
- Updated dependencies [ae54a60]
- Updated dependencies [7dd7055]
- Updated dependencies [e178bf4]
- Updated dependencies [d2f68ba]
- Updated dependencies [567c3b3]
- Updated dependencies [75191db]
- Updated dependencies [d395ad2]
- Updated dependencies [75407f3]
- Updated dependencies [8a2da9d]
- Updated dependencies [bfdd4b1]
- Updated dependencies [3ffa711]
- Updated dependencies [c2c3229]
- Updated dependencies [e559425]
- Updated dependencies [fc5c256]
- Updated dependencies [93fa469]
- Updated dependencies [14e00b1]
- Updated dependencies [f33286c]
- Updated dependencies [b3ad7eb]
- Updated dependencies [95cdf95]
- Updated dependencies [eabdb9c]
- Updated dependencies [9eeba53]
- Updated dependencies [49a9f4f]
- Updated dependencies [dcba383]
- Updated dependencies [c895c07]
- Updated dependencies [ed4b4a0]
- Updated dependencies [1102ce0]
- Updated dependencies [2ae432c]
- Updated dependencies [ad2ef56]
- Updated dependencies [9f87189]
- Updated dependencies [0f9b7ef]
- Updated dependencies [6d043ea]
- Updated dependencies [fe55a13]
- Updated dependencies [01fc2cb]
- Updated dependencies [f4aedad]
- Updated dependencies [f042c9d]
- Updated dependencies [0176aa8]
- Updated dependencies [00f2631]
- Updated dependencies [c13c1c1]
- Updated dependencies [0a6c8da]
- Updated dependencies [7a40517]
- Updated dependencies [91a2ac0]
- Updated dependencies [7bda0b2]
- Updated dependencies [c115600]
- Updated dependencies [b84a3d0]
  - @fragno-dev/db@0.4.0
  - @fragno-dev/core@0.2.1
  - @fragno-dev/node@0.0.9
