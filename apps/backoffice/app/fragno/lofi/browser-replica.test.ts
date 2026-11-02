import { afterEach, beforeEach, describe, expect, test, vi, assert } from "vitest";

import { getWorkerReplica, retainWorkerReplica } from "./browser-replica";
import { readWorkerReplicaName } from "./worker-replica-target";

/** A replica worker that opens at once and confirms closing, recording what the page sent it. */
function fakeWorker() {
  const sent: unknown[] = [];
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage(message: { type: string }) {
      sent.push(message);
      if (message.type === "close") {
        queueMicrotask(() => {
          worker.onmessage?.({ data: { type: "closed" } } as MessageEvent);
        });
      }
    },
    terminate: vi.fn(),
  };
  return { worker, sent };
}

let started: (ReturnType<typeof fakeWorker> & { name: string })[] = [];
let backend = 0;

/** Options for a backend no other test opened, since the tab's replicas outlive a test. */
function newBackend() {
  backend += 1;
  return {
    target: { baseUrl: `/api/automations/org/acme-${backend}`, adapterIdentity: "do:abc" },
    schemas: [],
    startWorker(name: string) {
      const fake = fakeWorker();
      started.push({ ...fake, name });
      queueMicrotask(() => {
        fake.worker.onmessage?.({
          data: { type: "status", status: { phase: "caught-up", error: null } },
        } as MessageEvent);
      });
      return fake.worker as unknown as Worker;
    },
  };
}

beforeEach(() => {
  started = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Makes the page look loaded over `protocol`, as `PerformanceNavigationTiming` names it. */
function loadedOver(protocol: string) {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    { nextHopProtocol: protocol } as PerformanceNavigationTiming,
  ]);
}

/** Whether the worker started `index`-th was named to poll once caught up. */
function pollsOnceCaughtUp(index: number): boolean {
  return readWorkerReplicaName(started[index]!.name).pollOnceCaughtUp !== undefined;
}

describe("worker replicas", () => {
  test("close once their last holder released them, after a delay", async () => {
    const options = newBackend();
    const first = retainWorkerReplica(options);
    const second = retainWorkerReplica(options);
    await first.replica;
    expect(started).toHaveLength(1);

    first.release();
    second.release();
    second.release();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(started[0]!.worker.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(started[0]!.sent).toContainEqual({ type: "close" });
    expect(started[0]!.worker.terminate).toHaveBeenCalledOnce();

    // Opening it again starts a new worker.
    await retainWorkerReplica(options).replica;
    expect(started).toHaveLength(2);
  });

  test("stay open when held again before the delay ends", async () => {
    const options = newBackend();
    const first = retainWorkerReplica(options);
    await first.replica;
    first.release();
    await vi.advanceTimersByTimeAsync(5_000);

    const again = retainWorkerReplica(options);
    expect(again.replica).toBe(first.replica);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(started).toHaveLength(1);
    expect(started[0]!.worker.terminate).not.toHaveBeenCalled();
  });

  test("stay open for the life of the tab once a view reads them unheld", async () => {
    const options = newBackend();
    const held = retainWorkerReplica(options);
    expect(getWorkerReplica(options)).toBe(held.replica);
    held.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started[0]!.worker.terminate).not.toHaveBeenCalled();
  });

  test("poll once caught up when only held, where the page came over HTTP/1.1", async () => {
    loadedOver("http/1.1");
    await retainWorkerReplica(newBackend()).replica;
    await getWorkerReplica(newBackend());
    expect([pollsOnceCaughtUp(0), pollsOnceCaughtUp(1)]).toEqual([true, false]);

    loadedOver("h2");
    await retainWorkerReplica(newBackend()).replica;
    assert(!pollsOnceCaughtUp(2));
  });

  test("terminate a worker that does not confirm closing", async () => {
    const options = newBackend();
    const held = retainWorkerReplica(options);
    await held.replica;
    started[0]!.worker.postMessage = (message) => {
      started[0]!.sent.push(message);
    };
    held.release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started[0]!.worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(started[0]!.worker.terminate).toHaveBeenCalledOnce();
  });
});
