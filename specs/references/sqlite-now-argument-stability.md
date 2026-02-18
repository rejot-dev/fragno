# SQLite now() argument stability

Source: https://til.simonwillison.net/sqlite/now-argument-stability

Summary: SQLite's `now`/`CURRENT_TIMESTAMP` style functions are stable within a single
statement/query but are re-evaluated for each statement, even within the same transaction.
