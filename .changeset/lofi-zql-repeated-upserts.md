---
"@fragno-dev/lofi-zql": patch
---

fix: keep ZQL views working when the replica writes one row twice in a batch, such as a projection
that upserts the same row for several mutations. The triggers that record rows' earlier values used
`INSERT OR IGNORE`, which the replica's upsert overrode, so the second write failed and rolled back
the batch.
