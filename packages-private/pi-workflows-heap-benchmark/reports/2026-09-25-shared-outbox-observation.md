# Catch-up isolation and shared live outbox observation

Date: September 25, 2026

## Goal

Verify that historical or small-page streams cannot pin current observers while preserving one
shared database poll for observers that have reached the live tail.

The measured server process owns SQLite, Fragno, the HTTP server, and memory sampling. One
unmeasured child process owns all concurrent HTTP clients. SQLite's `verbose` callback counts
measured `SELECT` statements containing `fragno_db_outbox`.

## Design

Every observer starts in `catching-up`:

- observers with the same cursor and limit may share a catch-up query;
- divergent catch-up groups progress independently;
- at most four catch-up pages are read per scheduler tick, in round-robin order;
- all unserviced observers still receive heartbeats;
- a page shorter than the observer's requested limit moves it to `live`.

Live observers are always serviced first. They share one 50-entry query and their requested stream
limits no longer control live database paging. Entries are delivered item by item rather than
materializing a page before writes.

## Live-tail workload with a lagging observer

The live scenario preloads 100 historical entries, connects current clients at the historical tail,
connects one historical observer with `limit=1`, waits for current clients to receive their initial
heartbeat, resets the SQL counter, and then appends 1,000 measured entries.

- 1 KiB mutation payload per entry
- 1 ms consumer delay per entry
- one active historical `limit=1` observer
- no allocation profiling

| Current clients | Outbox SQL reads | Duration | Aggregate entries/s | Lagging entries consumed | Peak heap rise | Peak RSS rise | Peak external rise |
| --------------: | ---------------: | -------: | ------------------: | -----------------------: | -------------: | ------------: | -----------------: |
|               1 |               40 |  6.130 s |              163.13 |                       21 |       14.7 MiB |      17.0 MiB |            0.4 MiB |
|              10 |               40 |  6.153 s |            1,625.10 |                       21 |       16.3 MiB |      22.9 MiB |            2.1 MiB |

The measured SQL count remained exactly 40 when current clients increased from one to ten. Each
scheduler pass performed one shared live query and one independent `limit=1` catch-up query. The
lagging observer continued progressing, while ten current clients completed in the same wall-clock
time as one and received identical entry counts and checksums.

## Mixed live and divergent catch-up workload

The benchmark now accepts `--lagging-clients COUNT`. Lagging clients receive evenly spaced
historical cursors so they form distinct catch-up groups. The first uses `limit=1`; subsequent
clients use the canonical 50-entry page. A separate SQLite writer connection in the measured server
appends entries under WAL while retrieval cursors are active.

The representative mixed workload used:

- two current clients at the live tail;
- one catch-up client from the beginning with `limit=1`;
- one catch-up client from the midpoint with `limit=50`;
- 1,000 historical and 1,000 measured entries;
- 128 KiB mutation payloads and a 5 ms consumer delay.

| Current clients | Catch-up clients | Outbox SQL reads | Duration | Catch-up entries by client | Peak heap rise | Retained heap rise | Peak RSS rise | Peak external rise |
| --------------: | ---------------: | ---------------: | -------: | -------------------------: | -------------: | -----------------: | ------------: | -----------------: |
|               2 |                2 |               60 | 13.392 s |                 22 / 1,020 |       33.4 MiB |           -0.8 MiB |      34.3 MiB |           13.2 MiB |

The 60 measured reads are 20 shared live queries plus 20 queries for each divergent catch-up group.
Both current clients received the same 1,000 entries and checksum. The midpoint client remained in
catch-up throughout the measured interval because new entries were appended ahead of it, while the
`limit=1` client continued making bounded progress. Peak V8 heap remained 51.3 MiB and returned
below its forced-GC baseline after teardown.

## Historical catch-up workload

The current benchmark preloads all entries before opening clients. It therefore measures catch-up,
not steady-state live polling.

- 1,000 preloaded entries
- 1 KiB mutation payload per entry
- 1 ms consumer delay per entry
- no allocation profiling

| Mode   | Clients | Outbox SQL reads | Duration | Aggregate entries/s | Peak heap rise | Peak RSS rise | Peak external rise |
| ------ | ------: | ---------------: | -------: | ------------------: | -------------: | ------------: | -----------------: |
| Poll   |       1 |               40 |  6.980 s |              143.27 |       16.2 MiB |      15.0 MiB |            2.1 MiB |
| Poll   |      10 |              400 |  6.953 s |            1,438.17 |       16.6 MiB |      25.1 MiB |            2.3 MiB |
| Stream |       1 |               20 |  5.852 s |              170.89 |       16.6 MiB |      15.4 MiB |            0.5 MiB |
| Stream |      10 |              178 | 10.885 s |              918.67 |       16.0 MiB |      22.2 MiB |            0.6 MiB |

The ten stream clients did not all register before the first catch-up query began, so later clients
formed additional compatible catch-up groups. That database amplification is intentional for
observers that have not reached the live tail: it prevents an earlier or `limit=1` observer from
controlling current clients.

This preloaded workload must not be used as evidence for steady-state live query scaling; the live
scenario above establishes that comparison after current clients are connected at the tail.

## Verification

Deterministic hub tests prove that:

- a historical `limit=1` observer and an observer at version 100 both receive their next entries in
  the same scheduler pass;
- no more than four divergent catch-up pages run per tick;
- after reaching the tail, a `limit=1` observer participates in the shared 50-entry live poll;
- live polling runs before catch-up work;
- entries are written before the iterator requests the next entry;
- observers that receive no entries get a heartbeat.

## Conclusion

Lagging observers no longer pin the global cursor or page size. Additional database reads scale with
distinct catch-up groups rather than current-client count. With one active lagging observer, one and
ten current clients both required 40 measured outbox SQL reads. With two current clients and two
divergent catch-up groups, the benchmark required the expected 60 reads while retaining no
additional V8 heap after teardown.
