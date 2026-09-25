import { assert, describe, expect, it } from "vitest";

import type { DatabaseHandlerTx } from "../db-fragment-definition-builder";
import { FragnoId } from "../schema/create";
import type { OutboxEntry } from "./outbox";
import { createOutboxObservationHub } from "./outbox-observation-hub";

const handlerTx = (() => {
  throw new Error("Shared outbox observation should read through its configured entry stream.");
}) as DatabaseHandlerTx;

function createEntry(versionstamp: string): OutboxEntry {
  return {
    id: FragnoId.fromExternal(`entry-${versionstamp}`, 1),
    versionstamp,
    uowId: `uow-${versionstamp}`,
    payload: { json: { version: 2, operations: [] } },
    createdAt: new Date("2026-09-25T00:00:00.000Z"),
  };
}

function createObserverRegistration(
  observerId: string,
  frames: string[],
  afterVersionstamp?: string,
  limit = 50,
) {
  return {
    observerId,
    afterVersionstamp,
    limit,
    writeFrame: async (frame: string) => {
      frames.push(frame);
      return true;
    },
    recordPoll: () => {},
    recordEntryRead: () => {},
    recordError: () => {},
  };
}

describe("outbox observation hub", () => {
  it("shares one database read across active observers", async () => {
    const entries = [createEntry("000000000000000000000000")];
    const reads: Array<{ afterVersionstamp: string | undefined; limit: number }> = [];
    const hub = createOutboxObservationHub(async function* (options) {
      reads.push(options);
      for (const entry of entries) {
        if (!options.afterVersionstamp || entry.versionstamp > options.afterVersionstamp) {
          yield entry;
        }
      }
    });
    const firstFrames: string[] = [];
    const secondFrames: string[] = [];
    const first = hub.registerOutboxObserver(createObserverRegistration("first", firstFrames));
    const second = hub.registerOutboxObserver(createObserverRegistration("second", secondFrames));

    await first.refreshNow(handlerTx);

    expect(reads).toHaveLength(1);
    expect(firstFrames).toEqual(secondFrames);
    expect(firstFrames).toHaveLength(1);
    expect(JSON.parse(firstFrames[0]!)).toMatchObject({
      versionstamp: entries[0]!.versionstamp,
    });

    first.close();
    second.close();
  });

  it("lets current observers progress independently from limited historical observers", async () => {
    const historicalEntry = createEntry("000000000000000000000000");
    const currentCursor = "000000000000000000000100";
    const currentEntry = createEntry("000000000000000000000101");
    const reads: Array<{ afterVersionstamp: string | undefined; limit: number }> = [];
    const hub = createOutboxObservationHub(async function* (options) {
      reads.push(options);
      if (options.afterVersionstamp === undefined) {
        yield historicalEntry;
      } else if (options.afterVersionstamp === currentCursor) {
        yield currentEntry;
      }
    });
    const historicalFrames: string[] = [];
    const currentFrames: string[] = [];
    const historical = hub.registerOutboxObserver(
      createObserverRegistration("historical", historicalFrames, undefined, 1),
    );
    const current = hub.registerOutboxObserver(
      createObserverRegistration("current", currentFrames, currentCursor),
    );

    await historical.refreshNow(handlerTx);

    expect(reads).toEqual([
      { afterVersionstamp: undefined, limit: 1 },
      { afterVersionstamp: currentCursor, limit: 50 },
    ]);
    expect(JSON.parse(historicalFrames[0]!)).toMatchObject({
      versionstamp: historicalEntry.versionstamp,
    });
    expect(JSON.parse(currentFrames[0]!)).toMatchObject({
      versionstamp: currentEntry.versionstamp,
    });
    historical.close();
    current.close();
  });

  it("uses the hub page size after an observer reaches the live tail", async () => {
    const reads: Array<{ afterVersionstamp: string | undefined; limit: number }> = [];
    const hub = createOutboxObservationHub(async function* (options) {
      reads.push(options);
      yield* [];
    });
    const observer = hub.registerOutboxObserver(
      createObserverRegistration("observer", [], "000000000000000000000100", 1),
    );

    await observer.refreshNow(handlerTx);
    await observer.refreshNow(handlerTx);

    expect(reads).toEqual([
      { afterVersionstamp: "000000000000000000000100", limit: 1 },
      { afterVersionstamp: "000000000000000000000100", limit: 50 },
    ]);
    observer.close();
  });

  it("services live observers first and bounds divergent catch-up reads per tick", async () => {
    const reads: Array<{ afterVersionstamp: string | undefined; limit: number }> = [];
    const hub = createOutboxObservationHub(async function* (options) {
      reads.push(options);
      yield* [];
    });
    const frames = Array.from({ length: 6 }, () => [] as string[]);
    const observers = frames.map((observerFrames, index) =>
      hub.registerOutboxObserver(
        createObserverRegistration(
          `observer-${index}`,
          observerFrames,
          index.toString().padStart(24, "0"),
        ),
      ),
    );

    await observers[0]!.refreshNow(handlerTx);

    expect(reads).toHaveLength(4);
    assert(frames.every((observerFrames) => observerFrames[0] === "\n"));

    reads.splice(0);
    await observers[0]!.refreshNow(handlerTx);

    expect(reads).toHaveLength(3);
    expect(reads[0]).toEqual({ afterVersionstamp: "000000000000000000000000", limit: 50 });
    for (const observer of observers) {
      observer.close();
    }
  });

  it("delivers each entry before requesting the next streamed entry", async () => {
    const firstEntry = createEntry("000000000000000000000000");
    const secondEntry = createEntry("000000000000000000000001");
    const events: string[] = [];
    const hub = createOutboxObservationHub(async function* () {
      events.push(`read:${firstEntry.versionstamp}`);
      yield firstEntry;
      events.push(`read:${secondEntry.versionstamp}`);
      yield secondEntry;
    });
    const observer = hub.registerOutboxObserver({
      ...createObserverRegistration("observer", []),
      writeFrame: async (frame) => {
        const parsed = JSON.parse(frame) as { versionstamp: string };
        events.push(`write:${parsed.versionstamp}`);
        return true;
      },
    });

    await observer.refreshNow(handlerTx);

    expect(events).toEqual([
      `read:${firstEntry.versionstamp}`,
      `write:${firstEntry.versionstamp}`,
      `read:${secondEntry.versionstamp}`,
      `write:${secondEntry.versionstamp}`,
    ]);
    observer.close();
  });

  it("sends a heartbeat to each observer that received no entries", async () => {
    const entry = createEntry("000000000000000000000001");
    const hub = createOutboxObservationHub(async function* () {
      yield entry;
    });
    const laggingFrames: string[] = [];
    const caughtUpFrames: string[] = [];
    const lagging = hub.registerOutboxObserver(
      createObserverRegistration("lagging", laggingFrames),
    );
    const caughtUp = hub.registerOutboxObserver(
      createObserverRegistration("caught-up", caughtUpFrames, entry.versionstamp),
    );

    await lagging.refreshNow(handlerTx);

    expect(laggingFrames).toHaveLength(1);
    expect(JSON.parse(laggingFrames[0]!)).toMatchObject({ versionstamp: entry.versionstamp });
    expect(caughtUpFrames).toEqual(["\n"]);
    lagging.close();
    caughtUp.close();
  });

  it("keeps one scheduler loop until the final observer lease stops", async () => {
    const hub = createOutboxObservationHub(async function* () {});
    const first = hub.registerOutboxObserver(createObserverRegistration("first", []));
    const second = hub.registerOutboxObserver(createObserverRegistration("second", []));
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();
    const firstLease = first.runWhile({
      signal: firstAbortController.signal,
      handlerTx,
    });
    const secondLease = second.runWhile({
      signal: secondAbortController.signal,
      handlerTx,
    });

    assert(hub.activeObserverCount() === 2);
    assert(hub.activeSchedulerLoopCount() === 1);

    first.close();
    firstAbortController.abort();
    await firstLease;

    assert(hub.activeObserverCount() === 1);
    assert(hub.activeSchedulerLoopCount() === 1);

    second.close();
    secondAbortController.abort();
    await secondLease;

    assert(hub.activeObserverCount() === 0);
    assert(hub.activeSchedulerLoopCount() === 0);
  });
});
