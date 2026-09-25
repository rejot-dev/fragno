import { assert, describe, expect, it, vi } from "vitest";

import type { DatabaseHandlerTx } from "../db-fragment-definition-builder";
import { FragnoId } from "../schema/create";
import type { OutboxEntry } from "./outbox";
import { createOutboxObservationHub } from "./outbox-observation-hub";
import { parseOutboxStreamFrame, type OutboxStreamFrame } from "./outbox-stream";

const handlerTx = (() => {
  throw new Error("Outbox observation uses its configured entry stream.");
}) as DatabaseHandlerTx;
function stamp(version: number): string {
  return version.toString(16).padStart(24, "0");
}
function createEntry(version: number): OutboxEntry {
  return {
    id: FragnoId.fromExternal(`entry-${version}`, 1),
    versionstamp: stamp(version),
    uowId: `uow-${version}`,
    payload: { json: { version: 2, operations: [] } },
    createdAt: new Date(0),
  };
}
function createScenario(entries: OutboxEntry[]) {
  const reads: Array<{ afterVersionstamp: string | undefined; limit: number }> = [];
  const events: string[] = [];
  const readErrors = new Map<number, Error>();
  const hub = createOutboxObservationHub(async function* (options) {
    reads.push(options);
    const readError = readErrors.get(reads.length);
    if (readError) {
      throw readError;
    }
    const page = entries
      .filter(
        (entry) =>
          options.afterVersionstamp === undefined || entry.versionstamp > options.afterVersionstamp,
      )
      .slice(0, options.limit);
    try {
      for (const entry of page) {
        events.push(`read:${entry.versionstamp}`);
        yield entry;
      }
    } finally {
      events.push("released");
    }
  });
  function observe(
    id: string,
    target: string | null,
    afterVersionstamp?: string,
    limit = 50,
    write: (frame: OutboxStreamFrame) => Promise<boolean> = async () => true,
  ) {
    const frames: OutboxStreamFrame[] = [];
    const observer = hub.registerOutboxObserver({
      observerId: id,
      catchUpTargetVersionstamp: target,
      afterVersionstamp,
      limit,
      async writeFrame(serialized) {
        const frame = parseOutboxStreamFrame(JSON.parse(serialized));
        events.push(
          `write:${id}:${frame.type === "entry" ? frame.entry.versionstamp : frame.type}`,
        );
        if (!(await write(frame))) {
          return false;
        }
        frames.push(frame);
        return true;
      },
      recordPoll() {},
      recordEntryRead() {},
      recordError() {},
    });
    return { observer, frames };
  }
  return { hub, reads, events, observe, readErrors };
}

describe("outbox observation hub", () => {
  it("drains bounded backlog pages without idle delays, then resumes idle polling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const scenario = createScenario(Array.from({ length: 180 }, (_, index) => createEntry(index)));
    const client = scenario.observe("client", stamp(179));
    const abort = new AbortController();
    let lease: Promise<void> | undefined;
    try {
      await client.observer.refreshNow(handlerTx);
      expect(client.frames).toHaveLength(50);
      lease = client.observer.runWhile({ signal: abort.signal, handlerTx });
      await vi.advanceTimersByTimeAsync(20);
      expect(client.frames.filter((frame) => frame.type === "entry")).toHaveLength(180);
      expect(client.frames.at(-1)).toEqual({ type: "caught-up", throughVersionstamp: stamp(179) });
      expect(scenario.reads).toEqual(
        [undefined, stamp(49), stamp(99), stamp(149)].map((afterVersionstamp) => ({
          afterVersionstamp,
          limit: 50,
        })),
      );
      expect(scenario.events.filter((event) => event === "released")).toHaveLength(4);
      assert(scenario.hub.activeSchedulerLoopCount() === 1);
      await vi.advanceTimersByTimeAsync(100);
      expect(scenario.reads).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(300);
      expect(scenario.reads).toHaveLength(5);
      expect(client.frames.at(-1)).toEqual({ type: "heartbeat" });
    } finally {
      client.observer.close();
      abort.abort();
      await lease;
      assert(scenario.hub.activeSchedulerLoopCount() === 0);
      assert(vi.getTimerCount() === 0);
      vi.useRealTimers();
    }
  });

  it("keeps live-first fairness and heartbeat cadence during rapid catch-up passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const entries = Array.from({ length: 180 }, (_, index) => createEntry(index));
    const scenario = createScenario(entries);
    const current = scenario.observe("current", stamp(179), stamp(179));
    const lagging = Array.from({ length: 6 }, (_, index) =>
      scenario.observe(`lag-${index}`, stamp(179), stamp(index * 10), 1),
    );
    const abort = new AbortController();
    let lease: Promise<void> | undefined;
    try {
      await current.observer.refreshNow(handlerTx);
      expect(scenario.reads).toHaveLength(5);
      scenario.events.length = 0;
      entries.push(createEntry(180));
      lease = current.observer.runWhile({ signal: abort.signal, handlerTx });
      await vi.advanceTimersByTimeAsync(10);
      expect(scenario.events.slice(0, 2)).toEqual([
        `read:${stamp(180)}`,
        `write:current:${stamp(180)}`,
      ]);
      for (const client of lagging) {
        expect(client.frames.filter((frame) => frame.type === "entry").length).toBeGreaterThan(1);
        expect(
          client.frames.filter((frame) => frame.type === "heartbeat").length,
        ).toBeLessThanOrEqual(1);
      }
      expect(current.frames.filter((frame) => frame.type === "heartbeat")).toHaveLength(1);
      assert(scenario.hub.activeSchedulerLoopCount() === 1);
    } finally {
      current.observer.close();
      lagging.forEach((client) => client.observer.close());
      abort.abort();
      await lease;
      vi.useRealTimers();
    }
  });

  it("exhausts only the in-flight bounded page when the final observer cancels during rapid draining", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const scenario = createScenario(Array.from({ length: 180 }, (_, index) => createEntry(index)));
    const abort = new AbortController();
    const client = scenario.observe("client", stamp(179), undefined, 50, async (frame) => {
      if (frame.type === "entry" && frame.entry.versionstamp === stamp(59)) {
        client.observer.close();
        abort.abort();
      }
      return true;
    });
    let lease: Promise<void> | undefined;
    try {
      await client.observer.refreshNow(handlerTx);
      lease = client.observer.runWhile({ signal: abort.signal, handlerTx });
      await vi.advanceTimersByTimeAsync(1000);
      await lease;
      expect(scenario.reads).toHaveLength(2);
      expect(client.frames).toHaveLength(60);
      expect(scenario.events.filter((event) => event.startsWith("read:"))).toHaveLength(100);
      assert(scenario.events.at(-1) === "released");
      assert(scenario.hub.activeObserverCount() === 0);
      assert(scenario.hub.activeSchedulerLoopCount() === 0);
      assert(vi.getTimerCount() === 0);
    } finally {
      client.observer.close();
      abort.abort();
      await lease;
      vi.useRealTimers();
    }
  });

  it("backs off after a failed backlog read instead of retrying in a hot loop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const scenario = createScenario(Array.from({ length: 70 }, (_, index) => createEntry(index)));
    scenario.readErrors.set(2, new Error("Transient outbox read failure"));
    const client = scenario.observe("client", stamp(69));
    const abort = new AbortController();
    let lease: Promise<void> | undefined;
    try {
      await client.observer.refreshNow(handlerTx);
      lease = client.observer.runWhile({ signal: abort.signal, handlerTx });
      await vi.advanceTimersByTimeAsync(20);
      expect(scenario.reads).toHaveLength(2);
      expect(client.frames).toHaveLength(50);
      await vi.advanceTimersByTimeAsync(300);
      expect(scenario.reads).toHaveLength(3);
      expect(scenario.reads[2]).toEqual({ afterVersionstamp: stamp(49), limit: 50 });
      expect(client.frames.filter((frame) => frame.type === "entry")).toHaveLength(70);
      expect(client.frames.at(-1)).toEqual({ type: "caught-up", throughVersionstamp: stamp(69) });
    } finally {
      client.observer.close();
      abort.abort();
      await lease;
      vi.useRealTimers();
    }
  });

  it("shares compatible reads and inserts each observer's fixed boundary before newer entries", async () => {
    const scenario = createScenario([createEntry(0), createEntry(1), createEntry(2)]);
    const first = scenario.observe("first", stamp(0));
    const second = scenario.observe("second", stamp(1));
    await first.observer.refreshNow(handlerTx);
    expect(scenario.reads).toHaveLength(1);
    expect(first.frames.map((frame) => frame.type)).toEqual([
      "entry",
      "caught-up",
      "entry",
      "entry",
    ]);
    expect(second.frames.map((frame) => frame.type)).toEqual([
      "entry",
      "entry",
      "caught-up",
      "entry",
    ]);
    expect(first.frames[1]).toEqual({ type: "caught-up", throughVersionstamp: stamp(0) });
    expect(second.frames[2]).toEqual({ type: "caught-up", throughVersionstamp: stamp(1) });
    first.observer.close();
    second.observer.close();
  });

  it("does not let continuous writes postpone the fixed catch-up boundary", async () => {
    const entries = [createEntry(0)];
    const scenario = createScenario(entries);
    const client = scenario.observe("client", stamp(0), undefined, 1, async (frame) => {
      if (frame.type === "entry") {
        entries.push(createEntry(entries.length));
      }
      return true;
    });
    await client.observer.refreshNow(handlerTx);
    expect(client.frames.map((frame) => frame.type)).toEqual(["entry", "caught-up"]);
    await client.observer.refreshNow(handlerTx);
    assert(scenario.reads[1]?.limit === 50);
    expect(client.frames.filter((frame) => frame.type === "caught-up")).toHaveLength(1);
    client.observer.close();
  });

  it("services live observers first with a hub-owned limit and budgets four divergent groups fairly", async () => {
    const scenario = createScenario(Array.from({ length: 12 }, (_, index) => createEntry(index)));
    const live = scenario.observe("live", stamp(11), stamp(11), 1);
    const lagging = Array.from({ length: 6 }, (_, index) =>
      scenario.observe(`lag-${index}`, stamp(11), stamp(index), 1),
    );
    await live.observer.refreshNow(handlerTx);
    expect(scenario.reads).toEqual([
      { afterVersionstamp: stamp(11), limit: 50 },
      ...[0, 1, 2, 3].map((index) => ({ afterVersionstamp: stamp(index), limit: 1 })),
    ]);
    scenario.reads.length = 0;
    await live.observer.refreshNow(handlerTx);
    expect(scenario.reads[0]).toEqual({ afterVersionstamp: stamp(11), limit: 50 });
    expect(scenario.reads.length).toBeLessThanOrEqual(5);
    for (const client of lagging) {
      assert(client.frames.some((frame) => frame.type === "entry"));
    }
    live.observer.close();
    lagging.forEach((client) => client.observer.close());
  });

  it("does not rewind the shared live cursor when a historical observer reaches its readiness target", async () => {
    const entries = [createEntry(0), createEntry(1), createEntry(2), createEntry(3)];
    const scenario = createScenario(entries);
    const current = scenario.observe("current", stamp(2), stamp(2));
    const historical = scenario.observe("historical", stamp(0), undefined, 1);
    await current.observer.refreshNow(handlerTx);
    expect(historical.frames.map((frame) => frame.type)).toEqual(["entry", "caught-up"]);
    scenario.reads.length = 0;
    entries.push(createEntry(4));
    await current.observer.refreshNow(handlerTx);
    expect(scenario.reads).toEqual([
      { afterVersionstamp: stamp(3), limit: 50 },
      { afterVersionstamp: stamp(0), limit: 1 },
    ]);
    expect(
      current.frames
        .filter((frame) => frame.type === "entry")
        .map((frame) => frame.entry.versionstamp),
    ).toEqual([stamp(3), stamp(4)]);
    expect(
      historical.frames
        .filter((frame) => frame.type === "entry")
        .map((frame) => frame.entry.versionstamp),
    ).toEqual([stamp(0), stamp(1)]);
    current.observer.close();
    historical.observer.close();
  });

  it("preserves item-wise backpressure while exhausting the bounded iterator on cancellation", async () => {
    const scenario = createScenario([createEntry(0), createEntry(1)]);
    const gate = Promise.withResolvers<boolean>();
    const writing = Promise.withResolvers<void>();
    const client = scenario.observe("client", stamp(1), undefined, 50, async () => {
      writing.resolve();
      return gate.promise;
    });
    const pass = client.observer.refreshNow(handlerTx);
    await writing.promise;
    expect(scenario.events).toEqual([`read:${stamp(0)}`, `write:client:${stamp(0)}`]);
    client.observer.close();
    gate.resolve(true);
    await pass;
    assert(scenario.events.at(-1) === "released");
    expect(scenario.events).toContain(`read:${stamp(1)}`);
    expect(scenario.events).not.toContain(`write:client:${stamp(1)}`);
  });

  it("emits per-observer heartbeats and isolates a failed control-frame write", async () => {
    const scenario = createScenario([createEntry(0)]);
    const lagging = scenario.observe("lagging", stamp(0));
    const current = scenario.observe("current", stamp(0), stamp(0));
    const failed = scenario.observe("failed", stamp(0), stamp(0), 50, async () => false);
    await current.observer.refreshNow(handlerTx);
    expect(current.frames).toEqual([
      { type: "caught-up", throughVersionstamp: stamp(0) },
      { type: "heartbeat" },
    ]);
    expect(lagging.frames.map((frame) => frame.type)).toEqual(["entry", "caught-up"]);
    expect(failed.frames).toEqual([]);
    assert(scenario.hub.activeObserverCount() === 2);
    current.observer.close();
    lagging.observer.close();
  });

  it("serializes rotation after an in-flight entry and writes no subsequent entries", async () => {
    const scenario = createScenario([createEntry(0), createEntry(1)]);
    const gate = Promise.withResolvers<boolean>();
    const writing = Promise.withResolvers<void>();
    const client = scenario.observe("client", stamp(1), undefined, 50, async (frame) => {
      if (frame.type === "entry") {
        writing.resolve();
        return gate.promise;
      }
      return true;
    });
    const pass = client.observer.refreshNow(handlerTx);
    await writing.promise;
    const rotating = client.observer.rotate(handlerTx);
    gate.resolve(true);
    await Promise.all([pass, rotating]);
    expect(client.frames.map((frame) => frame.type)).toEqual(["entry", "rotate"]);
    assert(scenario.hub.activeObserverCount() === 0);
  });

  it("marks an empty observer caught up and stops scheduler ownership after the final lease", async () => {
    const scenario = createScenario([]);
    const first = scenario.observe("first", null);
    const second = scenario.observe("second", null);
    await first.observer.refreshNow(handlerTx);
    expect(first.frames[0]).toEqual({ type: "caught-up", throughVersionstamp: null });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const firstLease = first.observer.runWhile({ signal: firstAbort.signal, handlerTx });
    const secondLease = second.observer.runWhile({ signal: secondAbort.signal, handlerTx });
    assert(scenario.hub.activeSchedulerLoopCount() === 1);
    first.observer.close();
    firstAbort.abort();
    await firstLease;
    assert(scenario.hub.activeSchedulerLoopCount() === 1);
    second.observer.close();
    secondAbort.abort();
    await secondLease;
    assert(scenario.hub.activeSchedulerLoopCount() === 0);
  });
});
