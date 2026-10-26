---
"@fragno-dev/db": patch
"@fragno-dev/workflows": patch
---

fix: Stop polling idle workflow steps while preserving event delivery, lifecycle writes, and
failed-flush retries. Pass `polling: "interval"` to `BufferedDatabasePump` for existing polling
behavior or `polling: "on-demand"` for writer-only scheduling; observer leases require interval
mode. Migrate scope and log metrics from `successfulFlushCount` and `emptyFlushCount` to
`flushCount`, `eventPollCount`, and `applicationEmissionsFlushed`.
