# Durable Streams read-path checklist

This checklist tracks Fragno's schema-scoped outbox projection against the read side of the Durable
Streams protocol.

## Compliance claim and reference baseline

The current implementation should be described as:

> A read-only Durable Streams-compatible JSON projection with HEAD, catch-up, conditional GET, and
> long-poll support.

It must not yet be described as a fully conforming Durable Streams server or a complete conforming
read path. Durable Streams explicitly permits independent read and write implementations, so Fragno
does not need protocol `PUT`, `POST`, or `DELETE` behavior to expose an externally populated outbox.
A complete read path still includes catch-up, long-poll, and SSE.

The reviewed upstream baseline is:

- Repository commit: [`a172acc389351cb3db6deb5cd60e3dec11e7ff39`][ds-reviewed-commit]
- Protocol SHA-256: `b8f39bcfe479079c07179b909be23c0a19714892265f3c788949b043c910552f`
- `@durable-streams/server-conformance-tests`: [`0.3.6`][ds-conformance-npm]
- Conformance source SHA-256: `9e42aa7274e345d3595f33afea5c7e38d1d8a6629e71d6ba4cbea59dc540779a`
- Review date: July 17, 2026

The latest package version and remote `main` were checked independently on July 17, 2026. The
snapshot in
[`src/outbox/durable-streams.conformance-snapshot.json`](src/outbox/durable-streams.conformance-snapshot.json)
pins the reviewed artifacts, but the normal CI job does not query npm or GitHub for newer releases.

### Current implementation map

- Protocol handler and offset mapping:
  [`src/outbox/durable-streams.ts`](src/outbox/durable-streams.ts)
  - `handleDurableStreamRequest`
  - `readOutboxPage`
  - `waitForSchemaEntries`
  - `outboxVersionstampToStreamOffset`
  - `streamOffsetToAfterVersionstamp`
  - `payloadMatchesSchema`
- Production `GET` and `HEAD` routes:
  [`src/fragments/internal-fragment.routes.ts`](src/fragments/internal-fragment.routes.ts)
  - `createInternalFragmentOutboxRoutes`
  - `handleDurableStream`
  - `resolveSchema`
- Efficient global tail lookup:
  [`src/fragments/internal-fragment.ts`](src/fragments/internal-fragment.ts)
  - `outboxService.tailVersionstamp`
- Real-HTTP in-memory fixture:
  [`src/outbox/durable-streams.test-fixture.ts`](src/outbox/durable-streams.test-fixture.ts)
- Read-path protocol suite:
  [`src/outbox/durable-streams.read-conformance.test.ts`](src/outbox/durable-streams.read-conformance.test.ts)
- Upstream freshness checks:
  [`src/outbox/durable-streams.conformance-freshness.test.ts`](src/outbox/durable-streams.conformance-freshness.test.ts)
- Node HTTP bridge used by the fixture:
  [`../fragno-node/fragno-node.ts`](../fragno-node/fragno-node.ts)
- User-facing behavior: [`README.md`](README.md#internal-outbox-read-apis)

### Current verification result

A forced run of `pnpm exec turbo run conformance:durable-streams --filter=@fragno-dev/db --force` on
July 17, 2026 reported:

- 2 passing test files
- 46 passing tests
- 3 skipped tests
  - the optional local-checkout freshness test, because `DURABLE_STREAMS_REPO` is intentionally not
    passed to the cacheable normal task
  - closed finite streams, which are not applicable to the always-open outbox projection
  - the current latest published upstream TypeScript client (`0.2.6`) paginated accumulation defect
- 1 todo test for SSE

The read-path file currently contributes 43 passing tests, two explicit skips, and one SSE todo.
Running the uncached freshness task with `DURABLE_STREAMS_REPO=/Users/wilco/dev/durable-streams`
reports 4 passing tests.

These are Fragno-owned fixture-driven tests modeled on the current protocol. They are not a passing
report from the official `runConformanceTests()` suite, because that suite currently creates streams
through protocol `PUT` and `POST` and has no externally seeded read-only fixture API.

## P0: Core read compatibility

- [x] Support `GET` without an `offset` by reading from the beginning of the stream.
- [x] Support `offset=-1` as the stream-beginning sentinel.
- [x] Support `offset=now` for catch-up reads, returning `[]`, the current tail offset, and
      `Stream-Up-To-Date: true`.
- [x] Support `offset=now&live=long-poll` by starting at the current tail and waiting only for
      future entries.
- [x] Keep generated offsets distinct from the reserved `-1` and `now` values.
- [x] Prove that the standard TypeScript client can begin, resume, reach the tail, long-poll, and
      cancel a schema stream without Fragno-specific protocol knowledge.
  - Executed against the production Node HTTP route with `@durable-streams/client` `0.2.6`.
  - Passing cases cover catch-up from `-1`, resumption from a server-minted offset, `offset=now`
    transition to long-poll, future delivery, and cancellation.
  - The fixture is populated only through normal Fragno mutations.
  - Sources: [protocol catch-up][ds-protocol-catch-up], [protocol long-poll][ds-protocol-long-poll],
    [TypeScript client package][ds-client-npm].
  - Implementation reference:
    [`durable-streams.read-conformance.test.ts`](src/outbox/durable-streams.read-conformance.test.ts),
    `standard TypeScript client`.
- [ ] Resolve or upstream the paginated accumulation defect in the current latest published
      `@durable-streams/client` (`0.2.6`).
  - A raw protocol client reconstructs the full 101-entry sequence correctly.
  - The standard client's `json()` and `jsonStream()` currently drop the final item when a 100-entry
    partial response is prefetched before the consumer observes its per-response `Stream-Up-To-Date`
    state.
  - The conformance suite keeps this case explicitly skipped so Fragno does not misattribute an
    upstream client state-machine defect to the server implementation.
  - This does not change the server's catch-up compliance, but it blocks claiming complete
    end-to-end pagination compatibility with client `0.2.6`.

## P0: Schema projection correctness

- [x] Resolve a stream into both its schema name and database namespace instead of reducing it to
      one string; ambiguous repeated logical schema names require their unique namespace URL.
- [x] Match outbox mutations against logical `mutation.schemaName`, physical `mutation.schema`, and
      `mutation.namespace` fields.
- [x] Test default namespaces, custom namespaces, and schemas without a namespace.
- [x] Test an outbox entry containing mutations for multiple schemas.
- [x] Document that schema streams use the global outbox versionstamp space as their watermark.
- [x] Decide whether a schema stream exposes an entire multi-schema `OutboxEntry` or rewrites its
      payload to contain only mutations for the requested schema.
  - Current behavior: `payloadMatchesSchema` decides whether an entry belongs in the response, but
    the response serializes the complete entry. A transaction touching schemas A and B therefore
    appears in both streams with both schemas' mutations present.
  - Decision: preserve the complete transaction as one atomic `OutboxEntry` message in every schema
    stream touched by that transaction.
  - The production-route test now creates a real cross-schema transaction and verifies both streams
    receive the same complete message.
  - New mutations include logical `schemaName` while preserving the existing physical `schema` and
    `namespace` fields. This fixes null-namespace ambiguity without invalidating older custom-
    namespace outbox entries.
  - Legacy null-namespace entries without `schemaName` are not guessed into a stream, preventing
    cross-schema disclosure; only newly disambiguated entries are projected.
  - Security consequence: schemas participating in one transaction must share an authorization
    boundary. This is documented in `README.md`.
  - Implementation reference: `payloadMatchesSchema` and `filterEntriesBySchema` in
    [`durable-streams.ts`](src/outbox/durable-streams.ts).
  - Source: [protocol multi-tenant safety][ds-protocol-security].

## P0: Long-poll correctness

- [x] Filter fetched outbox entries by schema before deciding that a long-poll has data to return.
- [x] Continue waiting when only unrelated schemas have produced entries.
- [x] Advance the internal global scan cursor while waiting so unrelated entries are not repeatedly
      scanned.
- [x] Return the correct global watermark in `Stream-Next-Offset` after scanning unrelated entries.
- [x] Stop the handler polling loop promptly when its supplied `AbortSignal` is aborted.
- [x] Test immediate data, delayed data, unrelated-schema traffic, timeout, and handler-level
      cancellation.
- [x] Test that every live response includes a numeric `Stream-Cursor`.
- [x] Test cursor collision handling produces a strictly greater cursor.
- [x] Prove real HTTP client-disconnect propagation through the production Node integration.
  - A native Node HTTP request now starts a production-route long-poll, destroys the socket, and
    verifies that [`toNodeHandler`](../fragno-node/fragno-node.ts) aborts `input.request.signal`.
  - The direct handler test separately verifies that polling performs no additional list calls after
    the signal aborts.
  - Non-Node framework integrations should repeat the transport-signal test when they gain dedicated
    Durable Streams fixtures.
  - Source: [protocol long-poll][ds-protocol-long-poll].
- [x] Include an ETag on long-poll `200 OK` responses.
  - Immediate and delayed `200` responses from concrete offsets include an ETag and support
    `If-None-Match`/`304`.
  - Requests that use the `offset=now` sentinel omit ETags, including when future data arrives,
    following the protocol's explicit exception for `offset=now` GET requests.
  - Concrete-offset timeout `204` responses also carry an ETag; `offset=now` responses retain the
    protocol's no-ETag exception.
  - Implementation reference: the long-poll branch of `handleDurableStreamRequest` in
    [`durable-streams.ts`](src/outbox/durable-streams.ts).
  - Sources: [protocol long-poll][ds-protocol-long-poll], [protocol caching][ds-protocol-caching],
    [official ETag tests][ds-conformance-etag].

## P0: Live-mode handling

- [x] Validate the `live` query parameter.
- [x] Return a clear `400 Bad Request` for unsupported live modes instead of silently returning
      catch-up JSON.
- [x] Explicitly reject `live=sse` until SSE support is implemented.
- [x] Define duplicate and malformed `live` and `cursor` query-parameter behavior.
  - Duplicate `live` or `cursor` parameters return `400`.
  - Cursors must use canonical non-negative decimal notation; empty, signed, prefixed, suffixed, and
    leading-zero values are rejected.
  - Cursor arithmetic uses `BigInt`, so values beyond `Number.MAX_SAFE_INTEGER` remain exact and are
    advanced monotonically without scientific notation.
  - Implementation reference: `generateCursor` and `handleDurableStreamRequest` in
    [`durable-streams.ts`](src/outbox/durable-streams.ts).
  - Sources: [protocol long-poll cursor rules][ds-protocol-caching], [official long-poll edge
    tests][ds-conformance-long-poll].

## P1: ETag and conditional reads

- [x] Pass request headers into the Durable Streams request handler.
- [x] Generate an ETag for every ordinary catch-up `GET` response.
- [x] Ensure the ETag identifies the stream, requested start offset, returned end offset, and
      relevant stream state.
- [x] Omit ETag for catch-up `offset=now` responses.
- [x] Return `304 Not Modified` with an empty body when `If-None-Match` matches.
- [x] Return `200 OK` when `If-None-Match` does not match.
- [x] Add CORS/preflight support for `If-None-Match` for cross-origin protocol clients.
  - `OPTIONS /_internal/outbox/durable/schema/:schema` returns `204` with allowed methods,
    `If-None-Match`, `Authorization`, `Content-Type`, wildcard origin, and a preflight max age.
  - Actual responses expose ETag and Durable Streams headers to browser clients.
  - Because the endpoint is internal and CORS-permissive, `README.md` requires applications to
    enforce authentication/authorization at the HTTP mount and use HTTPS.
  - Implementation reference:
    [`createInternalFragmentOutboxRoutes`](src/fragments/internal-fragment.routes.ts).
  - Sources: [official CORS/ETag test][ds-conformance-etag], [protocol browser security
    headers][ds-protocol-security].
- [x] Support the full HTTP `If-None-Match` comparison cases required by the intended HTTP profile.
  - Exact, weak, comma-list, wildcard, and non-matching validators are covered.
  - Matching validators return `304` with an empty body and the normal stream/security headers.
  - Implementation reference: `ifNoneMatchIncludes` in
    [`durable-streams.ts`](src/outbox/durable-streams.ts).

## P1: Bounded reads and pagination

- [x] Define a maximum of 100 scanned outbox entries per catch-up response.
- [x] Query only one bounded page instead of loading all remaining outbox history.
- [x] Set `Stream-Next-Offset` to the final scanned position in the returned page.
- [x] Include `Stream-Up-To-Date: true` only when the response reaches the current tail.
- [x] Omit `Stream-Up-To-Date` when additional data remains.
- [x] Verify repeated reads reconstruct the complete message sequence without skips or duplicates.
- [x] Add a 101-entry multi-page test.
- [x] Add adversarial sparse-stream pagination tests.
  - Cover more than 100 unrelated entries before the first matching entry.
  - Cover a page containing no matching entries and `Stream-Up-To-Date` absent.
  - Cover matching entries separated by several full unrelated pages.
  - Cover a matching entry in the 101st scanned position.
  - Confirm that both catch-up and long-poll eventually reach the correct global watermark without
    duplicate target entries.
  - Implementation references: `READ_PAGE_SIZE`, `readOutboxPage`, and `waitForSchemaEntries` in
    [`durable-streams.ts`](src/outbox/durable-streams.ts).
- [x] Explicitly accept and bound global application-level scanning for the current projection.
  - Current cost: a schema stream with one matching entry after 10,000 unrelated entries may require
    roughly 100 catch-up requests. A long-poll can issue roughly 100 database reads inside one HTTP
    request before it reaches that entry.
  - Idle long-polls query the database every 200 ms, approximately five reads per second per
    connection.
  - Decision: the current protocol primitive bounds every database scan to 101 global entries and
    advances its watermark even when a response contains no matching messages.
  - Total work remains proportional to unrelated history; a future schema projection/index is an
    optimization, not a wire-compliance blocker.
  - Any future storage optimization must preserve the global watermark contract.
  - Implementation references: [`internal-fragment.ts`](src/fragments/internal-fragment.ts) and
    [`durable-streams.ts`](src/outbox/durable-streams.ts).
  - Sources: [protocol bounded catch-up][ds-protocol-catch-up], [server implementation
    guidance][ds-building-server].

## P1: HEAD semantics and performance

- [x] Replace the full outbox scan used by `HEAD` with an efficient tail query.
- [x] Confirm and document that `HEAD` reports the global outbox watermark rather than the latest
      schema-specific entry.
- [x] Return `Content-Type: application/json` and `Stream-Next-Offset` for existing schema streams.
- [x] Return an empty body and `Cache-Control: no-store`.
- [x] Test empty streams, populated streams, unrelated-schema writes, and unknown schemas.
- [x] Exercise `tailVersionstamp` through the HTTP route on persistent SQL adapters.
  - The HTTP fixture now runs against SQLite/SQLocal and PGlite as well as `InMemoryAdapter`.
  - HEAD and catch-up verify the same tail offset after persistent-adapter writes.
  - `tailVersionstamp` orders the indexed outbox versionstamp descending with a limit of one, so it
    does not materialize outbox history.
  - Implementation reference: `outboxService.tailVersionstamp` in
    [`internal-fragment.ts`](src/fragments/internal-fragment.ts).
  - Source: [protocol HEAD][ds-protocol-head].

## P1: Response and error consistency

- [x] Apply `X-Content-Type-Options: nosniff` to route-level Durable Streams errors such as unknown
      schemas and disabled outboxes.
- [x] Apply `Cross-Origin-Resource-Policy` consistently to successful and Durable Streams error
      responses.
- [x] Use one Durable Streams error-response helper for protocol and routing errors handled by the
      Durable Streams routes.
- [x] Ensure malformed, empty, and duplicate offset parameters return `400 Bad Request`.
- [x] Continue ignoring unknown query parameters.
- [x] Reject uppercase versionstamp-shaped offsets because offsets are case-sensitive and Fragno
      only mints lowercase tokens.
- [x] Return `405 Method Not Allowed` for protocol writes to an existing read-only stream URL.
  - `POST`, `PUT`, `DELETE`, and `PATCH` now return `405` with `Allow: GET, HEAD, OPTIONS`.
  - Unknown stream URLs still return `404`; no test-only write behavior was added.
  - Method responses use the shared error helper and include cache, CORS, and browser security
    headers.
  - Source: [protocol append behavior for read-only streams][ds-protocol-append].
  - Implementation reference:
    [`createInternalFragmentOutboxRoutes`](src/fragments/internal-fragment.routes.ts).
- [x] Ensure framework-level errors on the stream URL receive the intended security headers.
  - Explicit method routes prevent existing streams from falling through to Fragno's generic 404.
  - Their `405` responses include `X-Content-Type-Options`, `Cross-Origin-Resource-Policy`, and CORS
    headers without changing unrelated Fragno errors.
  - Source: [protocol browser security headers][ds-protocol-security].

## P1: JSON stream semantics

- [x] Define the logical Durable Streams message as an `OutboxEntry` and document its serialized
      representation.
- [x] Verify every response body is a valid JSON array.
- [x] Verify empty ranges return exactly `[]`.
- [x] Verify message boundaries are preserved across pagination and long-poll responses.
- [x] Confirm reference-map and SuperJSON metadata serialization is stable over the production HTTP
      route.
  - The HTTP fixture seeds timestamps and a referenced entity through normal mutations, then
    asserts:
    - `refMap` keys and external IDs survive `JSON.stringify`;
    - `payload.meta` survives when SuperJSON needs metadata;
    - `FragnoId` has the documented JSON shape;
    - timestamps are ISO-8601 strings at the HTTP boundary;
    - resuming and pagination do not alter the message representation.
  - Implementation references: [`outbox.test.ts`](src/outbox/outbox.test.ts) and
    [`durable-streams.read-conformance.test.ts`](src/outbox/durable-streams.read-conformance.test.ts).
  - Source: [protocol JSON mode][ds-protocol-json].

## P1: Offset hardening

- [x] Define behavior at the maximum 24-character outbox versionstamp.
  - Stream offsets now use a fixed 25-character lowercase hexadecimal format while raw outbox
    versionstamps remain 24 characters.
  - `ffffffffffffffffffffffff` maps to `1000000000000000000000000`, remains parseable, and reverses
    exactly to the raw maximum.
  - Values above the maximum representable stream position are rejected with `400`.
  - Implementation reference: `STREAM_OFFSET_REGEX` and `outboxVersionstampToStreamOffset` in
    [`durable-streams.ts`](src/outbox/durable-streams.ts).
  - Source: [protocol offset invariants][ds-protocol-offsets].
- [x] Add offset property tests around ordering, uniqueness, sentinels, malformed tokens, and
      boundary values.
  - Includes zero, one, 1,000 adjacent positions, the highest supported value, malformed tokens,
    uppercase tokens, and out-of-range values.
  - Verify `streamOffsetToAfterVersionstamp(outboxVersionstampToStreamOffset(v)) === v` for every
    supported raw versionstamp.
  - Verify generated offsets never equal `-1` or `now` and remain lexicographically increasing.
  - Source: [official offset/property tests][ds-conformance-offsets].
- [x] Decide how to handle syntactically valid but non-server-minted offsets, including offsets
      beyond the current tail.
  - Fragno accepts any syntactically valid 25-character token within the representable offset range.
  - In-range future positions return `[]`, echo the requested position, and report up-to-date;
    values above the representable range return `400`.
  - Clients are still required to treat offsets as opaque and replay only server-minted values.
  - Source: [protocol offset invariants][ds-protocol-offsets].

## P1: Security, authorization, and lifecycle

- [x] Define the authorization boundary for internal outbox streams before public or cross-origin
      exposure.
  - The internal routes intentionally do not invent an application identity model.
  - `README.md` requires the host application's HTTP mount/middleware to authenticate and authorize
    `/_internal/outbox/**`, use HTTPS, and account for complete multi-schema transaction payloads.
  - Responses use `Cache-Control: no-store`; permissive CORS is safe only behind that required
    access control boundary.
  - Source: [protocol authentication and multi-tenant safety][ds-protocol-security].
  - Implementation reference:
    [`createInternalFragmentOutboxRoutes`](src/fragments/internal-fragment.routes.ts).
- [x] Define durable stream identity across schema registration, removal, rename, and namespace
      reuse.
  - Stream identity is deployment-coupled to the registered logical schema name or namespace.
  - `README.md` forbids renaming or reusing an old name/namespace for a different logical stream
    while historical outbox rows remain.
  - Removing a schema removes runtime access and returns `404`; these always-open projections do not
    model protocol deletion or closure.
  - A PGlite restart test verifies unchanged schema URLs, messages, and offsets remain valid.
  - Sources: [protocol stream model][ds-protocol-overview], [protocol HEAD][ds-protocol-head].
  - Implementation reference: `resolveSchema` in
    [`internal-fragment.routes.ts`](src/fragments/internal-fragment.routes.ts).
- [x] Ensure only schemas that opted into outbox production are exposed as meaningful schema
      streams, or document empty non-producing streams.
  - The adapter registry now exposes `listOutboxSchemas()` and `resolveSchema` only searches that
    set.
  - A registered schema that did not opt in returns `404` rather than an indefinitely empty stream.
  - This behavior is covered through the production HTTP route.
  - Implementation references: the adapter registry and
    [`internal-fragment.routes.ts`](src/fragments/internal-fragment.routes.ts).

## P2: SSE read mode

The protocol requires one control event after every data event. Because the stream content type is
`application/json`, each data event may contain a JSON array of complete `OutboxEntry` messages. The
existing indefinite NDJSON route at `/_internal/outbox/stream` is not an SSE implementation and must
remain a separate contract.

- [ ] Implement `GET ...?offset=<offset>&live=sse`.
  - Current behavior rejects `live=sse` with `400` in `handleDurableStreamRequest`.
  - Reuse the production route and normal outbox mutation path; do not add protocol writes.
  - Source: [protocol SSE][ds-protocol-sse], [official SSE tests][ds-conformance-sse].
- [ ] Return `Content-Type: text/event-stream` without `Content-Length`.
  - Add `Cache-Control` appropriate for a live internal stream and the existing browser security
    headers.
  - Verify headers through the actual Node response bridge, not only a direct `Response` object.
  - Source: [protocol SSE response][ds-protocol-sse].
- [ ] Emit each JSON data batch as one complete `event: data` event.
  - Preserve `OutboxEntry` boundaries and valid JSON array syntax.
  - Escape or split SSE `data:` lines without allowing payload newlines, CRLF, `event:`, or blank
    lines to inject events.
  - Source: [protocol SSE format][ds-protocol-sse], [official SSE injection
    tests][ds-conformance-sse].
- [ ] Emit an `event: control` after every data event.
  - Never emit another data batch without completing the previous batch's control event.
  - Emit a control event for an initially empty/caught-up stream as required.
  - Source: [protocol SSE control events][ds-protocol-sse].
- [ ] Include `streamNextOffset`, `streamCursor`, and `upToDate` in control events as required.
  - Use camelCase field names exactly.
  - `streamCursor` is required while the stream remains open.
  - The control offset must represent the final global outbox position scanned for that data batch.
  - Source: [protocol SSE control events][ds-protocol-sse].
- [ ] Support `offset=-1` and `offset=now` in SSE mode.
  - `offset=-1` sends historical matching data before waiting.
  - `offset=now` sends no historical data; its first control event reports the current tail and
    `upToDate: true` unless new data arrived first.
  - Source: [protocol offset sentinels][ds-protocol-offsets].
- [ ] Generate monotonically advancing cursors when clients echo a previous SSE cursor.
  - Share cursor generation with long-poll, but harden malformed and very large cursor input first.
  - Source: [protocol cursor generation][ds-protocol-caching].
- [ ] Recycle SSE connections at an appropriate interval.
  - The protocol recommends roughly 60 seconds so reconnecting clients can participate in CDN
    collapsing.
  - The client must be able to resume from the last control offset without duplicates.
  - Source: [protocol SSE lifecycle][ds-protocol-sse].
- [ ] Stop database observation immediately when the SSE client disconnects.
  - Verify actual HTTP disconnect propagation, observer cleanup, timer cleanup, and database polling
    cleanup.
  - Do not leave an outbox pump or polling loop alive after `ReadableStream.cancel()` or socket
    close.
  - Implementation references: the existing NDJSON pump in
    [`internal-fragment.routes.ts`](src/fragments/internal-fragment.routes.ts) and the
    request-signal concerns in the long-poll section.
- [ ] Add SSE framing, reconnection, cursor, empty-stream, offset-now, pagination, and
      injection-safety tests.
  - Mirror every applicable official test in the upstream `SSE Mode` section.
  - Exercise the production route with normal Fragno mutations.
  - Keep finite-stream closure tests explicitly not applicable while outbox streams cannot close.
  - Source: [official SSE tests][ds-conformance-sse].

## P1: Adapter, durability, and concurrency coverage

- [x] Run the production HTTP fixture against SQLite/SQLocal and PGlite in addition to the in-memory
      adapter.
  - The shared fixture now supports `in-memory`, `kysely-sqlite`, and `kysely-pglite`.
  - Persistent-adapter cases cover production-route HEAD, catch-up, resumption, immediate long-poll,
    message representation, and tail lookup.
  - MySQL, network Postgres, and Cloudflare Durable Objects remain additional adapter coverage, not
    blockers for the selected release matrix.
  - Source: [Durable Streams implementation testing guidance][ds-implementation-testing].
- [x] Add restart-durability tests for persisted offsets and message bytes.
  - A file-backed PGlite case appends an entry, records the returned stream offset, closes and
    recreates the adapter/server, replays the message, and resumes from the old offset.
  - The persisted message bytes and offset remain valid after restart.
  - Source: [protocol durability and persistent offsets][ds-protocol-offsets], [implementation
    testing guidance][ds-implementation-testing].
- [x] Add concurrent reader and writer tests.
  - Ten concurrent commits produce complete entries with unique, strictly increasing outbox
    versionstamps.
  - Five concurrent long-poll readers receive ordered prefixes, never torn or reordered entries.
  - Seven concurrent catch-up readers receive the same complete ordered sequence after commit.
  - Source: [implementation testing guidance][ds-implementation-testing], [official property
    tests][ds-conformance-offsets].

## Conformance harness

- [x] Upgrade `@durable-streams/server-conformance-tests` from the `0.2.x` range to the reviewed
      protocol-compatible version `0.3.6`.
- [x] Stop discovering scoped tests by scraping generated JavaScript test titles.
- [x] Build a read-only fixture that pre-seeds data through normal Fragno database mutations.
- [x] Point tests at fixed existing schema-stream URLs rather than arbitrary `v1/stream/<name>`
      paths.
- [x] Replace protocol `PUT` and `POST` test setup with equivalent Fragno mutations.
- [x] Separate applicable read-only behavior from write, delete, fork-creation, TTL, producer, and
      subscription behavior.
- [x] Report passed, skipped, todo, and not-applicable cases through Vitest.
- [x] Run freshness checks against the configured local Durable Streams `0.3.6` checkout.
- [x] Add the deterministic, cacheable read-path task to CI.
- [ ] Obtain a fixture-driven official read-only conformance runner or contribute one upstream.
  - Desired API: an upstream `runReadConformanceTests()` or equivalent that receives existing stream
    URLs and callbacks to append externally populated messages.
  - It must not assume protocol `PUT`/`POST`, arbitrary `/v1/stream/<id>` creation, stream deletion,
    TTL, forks, producers, or closure.
  - Until available, do not label the Fragno-owned suite an official conformance result.
  - Source: [official server conformance documentation][ds-building-server], [official conformance
    source][ds-conformance-source].
- [x] Maintain a reviewed test-by-test applicability manifest for the official suite.
  - [`DURABLE_STREAMS_READ_CONFORMANCE_MANIFEST.md`](DURABLE_STREAMS_READ_CONFORMANCE_MANIFEST.md)
    records each applicable upstream read-test title and its corresponding Fragno evidence.
  - SSE is deferred as one upstream section; write, lifecycle, binary, and subscription areas are
    classified as not applicable to this fixed-JSON externally populated projection.
  - The pinned source-tree hashes force re-review whenever upstream conformance source changes.
- [x] Make freshness CI detect newly available upstream releases, not only installed-source drift.
  - `.github/workflows/durable-streams-freshness.yml` runs weekly and on manual dispatch.
  - It compares npm's latest server-conformance package with the snapshot, checks out upstream
    `main`, and runs the exact commit/protocol/server-tree/client-tree freshness assertions.
  - The normal PR conformance task remains deterministic and cacheable.
  - Implementation reference:
    [`durable-streams.conformance-freshness.test.ts`](src/outbox/durable-streams.conformance-freshness.test.ts).
- [x] Validate the configured upstream checkout's actual Git HEAD and a complete relevant source
      tree digest.
  - The external freshness task now runs `git rev-parse HEAD` and compares it with the reviewed
    commit.
  - It hashes the complete server-conformance and client source trees, while retaining the pinned
    protocol and package-source hashes.
  - Installed client and server package versions/source trees are also checked in the deterministic
    normal task.
  - The external task remains uncached because the checkout is outside Turbo's workspace input
    graph.

## Cleanup and API review

- [x] Decide whether `FragnoRouteConfig.acceptAnyContentType` is needed before a Durable Streams
      write path exists.
- [x] Remove it because the read-only routes do not consume request bodies.
- [x] Replace `/outbox/**:path` with an explicit single-segment `/outbox/durable/schema/:schema`
      route that cannot collide with the legacy NDJSON stream.
- [x] Document the difference between `/_internal/outbox/stream` NDJSON streaming and schema-scoped
      Durable Streams.
- [x] Add user-facing documentation for stream discovery, initial offsets, resumption, and supported
      live modes.
- [x] Update the conformance snapshot's unsupported-area descriptions as evidence changes.
  - The snapshot now lists SSE as the only unsupported read area.
  - Closed finite streams, protocol writes/deletion, TTL/expiry, forks, producers, and subscriptions
    are recorded separately as not applicable to this externally populated always-open projection.
  - Covered areas now include the standard client, real Node disconnect propagation, CORS, read-only
    method responses, and the persistent-adapter matrix.
  - Implementation reference:
    [`durable-streams.conformance-snapshot.json`](src/outbox/durable-streams.conformance-snapshot.json).

## Definition of done

- [x] A standard Durable Streams client can begin, resume, reach the tail, long-poll, and cancel
      without implementation-specific knowledge for non-paginated catch-up ranges.
  - Catch-up and long-poll execute against the production route.
  - Multi-page accumulation remains blocked by the upstream client `0.2.6` defect recorded above.
  - Explicit SSE client mode remains deferred with SSE.
- [x] Catch-up reads resume without duplicate or missing outbox entries in the in-memory HTTP
      fixture.
- [x] Long-polls ignore unrelated schema traffic and wake for relevant mutations in the in-memory
      HTTP fixture.
- [x] HEAD, catch-up, long-poll, and conditional GET satisfy every applicable MUST in the reviewed
      protocol; SSE is explicitly deferred.
  - The only deferred protocol read mode is SSE.
  - Long-poll ETags, conditional GET, CORS preflight, method errors, security headers, and offset
    boundaries are covered.
- [ ] Applicable official conformance tests run through an upstream-supported externally seeded
      read-only fixture, or an explicitly reviewed equivalent is accepted by the Durable Streams
      project.
- [x] Reads are bounded and do not materialize the entire outbox in one response.
- [x] Every sparse-stream scan is bounded and advances the global watermark; total work is accepted
      as proportional to retained unrelated history.
- [x] Custom database namespaces produce the correct schema stream in the in-memory fixture.
- [x] The production HTTP suite passes on the selected in-memory, SQLite/SQLocal, and PGlite adapter
      tiers.
- [x] Real HTTP client cancellation stops long-poll work promptly; SSE cancellation is deferred with
      SSE itself.
- [x] Stream authorization and multi-schema payload visibility are explicitly defined for the
      intended internal deployment boundary.
- [x] Stream identity and schema lifecycle constraints are documented for application restarts and
      deployments.
- [x] All currently implemented Fragno DB tests, type checks, formatting, and read-path checks pass
      in CI.

## Upstream source references

[ds-reviewed-commit]:
  https://github.com/durable-streams/durable-streams/tree/a172acc389351cb3db6deb5cd60e3dec11e7ff39
[ds-conformance-npm]:
  https://www.npmjs.com/package/@durable-streams/server-conformance-tests/v/0.3.6
[ds-client-npm]: https://www.npmjs.com/package/@durable-streams/client/v/0.2.6
[ds-protocol-overview]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/PROTOCOL.md#3-protocol-overview
[ds-protocol-append]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/PROTOCOL.md#52-append-to-stream
[ds-protocol-head]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/PROTOCOL.md#55-stream-metadata
[ds-protocol-catch-up]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/PROTOCOL.md#56-read-stream---catch-up
[ds-protocol-long-poll]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/PROTOCOL.md#57-read-stream---live-long-poll
[ds-protocol-sse]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/PROTOCOL.md#58-read-stream---live-sse
[ds-protocol-offsets]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/PROTOCOL.md#8-offsets
[ds-protocol-json]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/PROTOCOL.md#91-json-mode
[ds-protocol-caching]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/PROTOCOL.md#10-caching-and-collapsing
[ds-protocol-security]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/PROTOCOL.md#12-security-considerations
[ds-building-server]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/docs/building-a-server.md
[ds-implementation-testing]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/IMPLEMENTATION_TESTING.md
[ds-client-stream-api]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/packages/client/src/stream-api.ts
[ds-conformance-source]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/packages/server-conformance-tests/src/index.ts
[ds-conformance-offsets]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/packages/server-conformance-tests/src/index.ts#L1467-L1988
[ds-conformance-long-poll]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/packages/server-conformance-tests/src/index.ts#L2278-L2452
[ds-conformance-etag]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/packages/server-conformance-tests/src/index.ts#L3176-L3313
[ds-conformance-sse]:
  https://github.com/durable-streams/durable-streams/blob/a172acc389351cb3db6deb5cd60e3dec11e7ff39/packages/server-conformance-tests/src/index.ts#L3521-L4571
