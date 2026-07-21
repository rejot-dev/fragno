# Durable Streams read-only conformance manifest

Reviewed against `@durable-streams/server-conformance-tests` `0.3.6` and Durable Streams commit
`a172acc389351cb3db6deb5cd60e3dec11e7ff39` on July 17, 2026.

The official runner cannot execute these cases directly against Fragno because its setup creates
arbitrary streams through protocol `PUT` and `POST`. The Fragno tests below reproduce the applicable
assertions over existing schema stream URLs, populate data through normal database mutations, and
exercise the production routes through `toNodeHandler`.

The pinned source and complete source-tree hashes in
[`src/outbox/durable-streams.conformance-snapshot.json`](src/outbox/durable-streams.conformance-snapshot.json)
force this manifest to be reviewed whenever upstream changes.

## Applicable tests

| Upstream `0.3.6` test                                                                | Fragno test/evidence                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| should include X-Content-Type-Options: nosniff on GET responses                      | HEAD/catch-up/error header assertions                                          |
| should include X-Content-Type-Options: nosniff on HEAD responses                     | `returns metadata without a body for an empty schema stream`                   |
| should include Cross-Origin-Resource-Policy header on GET responses                  | secured success/error assertions                                               |
| should include Cache-Control: no-store on HEAD responses                             | `returns metadata without a body for an empty schema stream`                   |
| should include X-Content-Type-Options: nosniff on long-poll responses                | `returns the required headers on timeout`                                      |
| should include security headers on error responses                                   | `returns secured 404 responses for unknown schema streams`                     |
| should return stream content-type on GET                                             | all JSON catch-up assertions                                                   |
| should return metadata without body                                                  | `returns metadata without a body for an empty schema stream`                   |
| should return 404 for non-existent stream                                            | unknown schema GET and HEAD assertions                                         |
| should return tail offset                                                            | `returns the global outbox watermark as the tail offset`                       |
| should accept -1 as sentinel for stream beginning                                    | `reads from the beginning when offset is omitted or -1`                        |
| should return same data for offset=-1 and no offset                                  | `reads from the beginning when offset is omitted or -1`                        |
| should accept offset=now as sentinel for current tail position                       | `supports offset=now and resumes from the returned tail`                       |
| should return correct tail offset for offset=now                                     | `supports offset=now and resumes from the returned tail`                       |
| should be able to resume from offset=now result                                      | `supports offset=now and resumes from the returned tail`                       |
| should work with offset=now on empty stream                                          | long-poll timeout and empty HEAD/catch-up cases                                |
| should return empty JSON array for offset=now on JSON streams                        | `supports offset=now and resumes from the returned tail`                       |
| should support offset=now with long-poll mode (waits for data)                       | timeout and no-history long-poll cases                                         |
| should receive data with offset=now long-poll when appended                          | `does not attach an ETag to offset=now long-poll responses`                    |
| should return 404 for offset=now on non-existent stream                              | unknown schema routing occurs before offset handling                           |
| should return 404 for offset=now with long-poll on non-existent stream               | unknown schema routing occurs before offset handling                           |
| should support offset=now with long-poll on empty stream                             | `returns the required headers on timeout`                                      |
| should reject malformed offset (contains comma)                                      | `validates offset cardinality, syntax, case, and range`                        |
| should reject offset with spaces                                                     | `validates offset cardinality, syntax, case, and range`                        |
| should support resumable reads (no duplicate data)                                   | `resumes exclusively from a returned offset without duplicates`                |
| should return empty response when reading from tail offset                           | `returns an empty JSON array when reading from the tail`                       |
| should preserve data immutability by position                                        | resumption, pagination, and restart tests                                      |
| should generate unique, monotonically increasing offsets                             | `maps outbox positions to unique, ordered, reversible stream offsets`          |
| should reject empty offset parameter                                                 | `validates offset cardinality, syntax, case, and range`                        |
| should reject multiple offset parameters                                             | `validates offset cardinality, syntax, case, and range`                        |
| should ignore unknown query parameters                                               | `ignores unknown query parameters`                                             |
| should require offset parameter for long-poll                                        | `validates required, duplicate, and malformed live parameters`                 |
| should generate Stream-Cursor header on long-poll responses                          | immediate and timeout long-poll tests                                          |
| should return immediately with Stream-Up-To-Date when data exists at offset          | `returns relevant entries that already exist with a cursor and ETag`           |
| should echo cursor and handle collision with jitter                                  | `advances a colliding cursor, including values beyond Number.MAX_SAFE_INTEGER` |
| should return Stream-Cursor, Stream-Up-To-Date and Stream-Next-Offset on 204 timeout | `returns the required headers on timeout`                                      |
| should generate ETag on GET responses                                                | catch-up and long-poll ETag assertions                                         |
| should return 304 Not Modified for matching If-None-Match                            | catch-up and long-poll conditional-read tests                                  |
| should allow If-None-Match in CORS preflight responses                               | `returns a complete conditional-GET CORS preflight response`                   |
| should return 200 for non-matching If-None-Match                                     | `returns 304 for exact, weak, wildcard, and comma-list If-None-Match values`   |
| should return new ETag after data changes                                            | same conditional-read test                                                     |
| should preserve JSON structure and nesting                                           | `serializes each OutboxEntry as one stable JSON message`                       |
| should work with client json() iterator                                              | standard TypeScript client catch-up test                                       |
| offsets are always monotonically increasing                                          | offset property and concurrent commit tests                                    |
| read-your-writes: data is immediately visible after append                           | all mutation-then-fetch production-route tests                                 |
| data at offset never changes after additional appends                                | resumption and restart tests                                                   |
| should reject offsets with invalid characters                                        | `validates offset cardinality, syntax, case, and range`                        |

Additional Fragno-specific protocol coverage includes schema/namespace projection, outbox-only
schema existence, complete multi-schema transaction payloads, sparse global-watermark pages,
SuperJSON and reference-map serialization, real Node HTTP disconnect propagation, read-only `405`
responses, SQLite/PGlite behavior, restart durability, and concurrent readers/writers.

## Deferred

Every test in the upstream `SSE Mode` section is deferred together. Fragno currently rejects
`live=sse` with `400 Bad Request`; it does not silently substitute JSON catch-up or long-poll.

## Not applicable to the read-only outbox projection

- Stream creation, append, close, and deletion
- Content-type validation for protocol writes
- TTL and absolute expiry
- Idempotent producers and `Stream-Seq`
- Fork creation and fork lifecycle
- Reserved subscription APIs and delivery
- Closed finite-stream EOF behavior; Fragno outbox streams are always open
- Binary and non-JSON stream behavior; the outbox projection is fixed to `application/json`

## Upstream fixture blocker

A direct official pass remains blocked until the upstream package accepts externally populated
existing stream URLs or exposes a fixture-driven read-only runner. Fragno must not add production
`PUT`/`POST` behavior solely to satisfy test setup.
