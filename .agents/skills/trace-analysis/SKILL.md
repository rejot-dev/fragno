---
name: trace-analysis
description:
  Local Backoffice trace forensics. Use for a trace id, slow request, span explosion, Durable Object
  storage activity, durable-hook propagation, missing Fragno spans, or local observability-store
  growth. Use only when analysis local traces.
---

# Backoffice Trace Forensics

Reconstruct the execution from Cloudflare Local Explorer evidence before reading implementation code
or proposing a fix.

## 1. Establish the evidence boundary

Backoffice normally runs on `http://localhost:5173`; Vite may choose `5174` or another port. Probe
the running server rather than starting a second one.

The read-only SQL endpoint is normally:

```text
POST /cdn-cgi/local/explorer/api/local/observability/query
```

Some Cloudflare versions omit the first `/local`. Inspect dev-server output when the route differs.
Send JSON shaped as:

```json
{ "sql": "SELECT COUNT(*) FROM spans", "params": [] }
```

Use parameterized, bounded queries with a timeout and `Connection: close`.

Local traces persist in a hashed SQLite database under:

```text
apps/backoffice/.wrangler/state/v3/observability/miniflare-wobs-trace-store/
```

Discover it instead of hardcoding the hash:

```bash
TRACE_DB=$(find apps/backoffice/.wrangler/state/v3/observability/miniflare-wobs-trace-store \
  -maxdepth 1 -name '*.sqlite' ! -name 'metadata.sqlite' -print -quit)
```

The fundamental schema is:

```text
spans(trace_id, span_id, parent_id, service, name, kind, start_ms,
      duration_ms, outcome, error, attributes, created_at)
logs(trace_id, span_id, seq, ts_ms, level, message, operation, created_at)
```

`attributes` is SQLite JSONB. Through Local Explorer, decode it with `json(attributes)` before
`json_extract`.

**Complete when:** the live origin and one working query path are proven.

## 2. Resolve one trace

Expand abbreviated ids before analysis:

```sql
SELECT trace_id, COUNT(*) AS span_count
FROM spans
WHERE trace_id LIKE ?
GROUP BY trace_id;
```

When given a hook, event, route, or time window, resolve the trace through that stable identifier.
Useful Fragno attributes include:

```text
fragno.hook.namespace
fragno.hook.name
fragno.hook.id
fragno.hook.has_propagation_context
fragno.db.fragment.name
fragno.db.transaction.name
fragno.db.transaction.kind
fragno.db.transaction.callback
db.query.text
```

Mark cold-start, HMR, devtools-discovery, and temporary-probe traces because they can distort
behavior.

**Complete when:** one full trace id, its selection evidence, and whether it is representative are
explicit.

## 3. Reconstruct the execution

Start with the whole trace ordered by time:

```sql
SELECT span_id, parent_id, service, name, kind, start_ms,
       duration_ms, outcome, error, json(attributes) AS attributes
FROM spans
WHERE trace_id = ?
ORDER BY start_ms, span_id;
```

Then group repeated work:

```sql
SELECT name, service, COUNT(*) AS count,
       SUM(COALESCE(duration_ms, 0)) AS summed_ms,
       MAX(COALESCE(duration_ms, 0)) AS max_ms
FROM spans
WHERE trace_id = ?
GROUP BY name, service
ORDER BY count DESC, summed_ms DESC;
```

Calculate wall time as the latest span end minus the earliest start. Summed duration measures work,
not elapsed time, because spans overlap. Account for every span as a root, child, orphan, or member
of a repeated group.

**Complete when:** roots, wall time, critical branch, errors, incomplete spans, and dominant groups
are accounted for.

## 4. Explain amplification

Trace repeated spans downward:

```text
request/event/alarm
  → scheduler pass
    → handler/service transaction
      → callback
        → runtime fetch/storage execution
```

For `durable_object_storage_exec`, group first by parent span and then by `db.query.text`. Classify
queries by semantic operation, such as hook wake polling, pending/stuck claims, hook lookup, status
update, settings, outbox, healthcheck, or application data access.

A large span count is evidence of amplification, not automatically an infinite loop. Check whether
counts continue growing after traffic stops and which parent repeatedly creates the children.

Treat probes as actors. Manual `alarm()`, drain, scheduler, retry, or nested awaited Durable Object
calls can add scheduler passes and automatic `fetch` spans. Exercise the real enqueue-to-alarm
lifecycle when testing that lifecycle.

**Complete when:** low-level counts reconcile with named parent operations, or the exact unexplained
remainder is stated.

## 5. Correlate Fragno semantics

Inspect `fragno.durable_hook.attempt`, `fragno.db.%`, their parentage, and correlated logs:

```sql
SELECT ts_ms, level, message, operation, span_id
FROM logs
WHERE trace_id = ?
ORDER BY ts_ms, seq;
```

A lifecycle log proves code ran; it does not prove a custom span was exported. Verify the span row.
`fragno.hook.has_propagation_context = false` identifies an asynchronous causality gap across
capture, persistence, restoration, or child/link creation.

Read implementation code only after the trace identifies the operation to inspect.

**Complete when:** each domain operation is connected to its spans and logs, and missing
relationships are localized to a boundary.

## 6. Keep store maintenance separate

Prefer the SQL API while Backoffice runs. Use SQLite read-only when the server is unavailable or the
API is under investigation. The companion `.sqlite-wal` and `.sqlite-shm` files are normal.

For store slowness, measure span/log counts, database size, WAL size, `page_count`, and
`freelist_count`. Stop Backoffice before direct mutation. Delete only proven disposable trace ids,
delete matching logs before spans, and preserve unrelated traces.

**Complete when:** query slowness is separated from worker slowness and any mutation has an explicit
trace-id change set.

## Report

Lead with the causal explanation. Include the full trace id, selection key, wall time, critical
branch, dominant groups, storage-operation counts, propagation state, probe distortion, observed
facts versus inference, and the exact SQL needed to reproduce the conclusion.

**Complete when:** the counts reconcile with the described execution path and another agent can
rerun the evidence.
