---
"@fragno-dev/lofi": patch
---

feat: refresh replica views by the tables a batch wrote, and add guarded SQL views. The replica
records the tables each batch writes and passes them to `replica.subscribe` listeners as
`{ tables }`, and engines' `refresh(changed)`; SQL and read views run again only after batches that
wrote a table they read, which statements report as `statement.tables`. The synchronous connection
prepares one statement at a time and adds `guarded(guard, run)`, which authorizes what statements
read and limits their work and string length. `guardedSqlViewEngine` maintains views of SQL that
people or agents write over its views and derived relations: they cannot write or call functions
whose result changes on their own, and stop at row, byte, and operation limits. Replica workers no
longer bundle the OPFS worker of `@tanstack/browser-db-sqlite-persistence`, which only
`openLofiSqliteReplica` opens. `quoteSqliteIdentifier` is exported, to build SQL over the replica's
table names.
