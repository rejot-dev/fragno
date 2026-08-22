import { afterEach, assert, describe, expect, it, vi } from "vitest";

import { openFragnoBrowserPersistenceWithDiagnostics } from "./fragno-browser-persistence-startup";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Fragno browser persistence startup", () => {
  it("reports diagnostics after three seconds and keeps waiting for persistence", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const persistenceOpening = Promise.withResolvers<{ opened: true }>();
    const persistenceOpeningStarted = Promise.withResolvers<void>();
    let startupSettled = false;
    const diagnosticsReported: unknown[] = [];
    const startupPromise = openFragnoBrowserPersistenceWithDiagnostics({
      databaseName: "fragno-test.sqlite",
      onDiagnostic(diagnostics) {
        diagnosticsReported.push(diagnostics);
      },
      openPersistence() {
        persistenceOpeningStarted.resolve();
        return persistenceOpening.promise;
      },
    });
    void startupPromise.then(
      () => {
        startupSettled = true;
      },
      () => {
        startupSettled = true;
      },
    );

    await persistenceOpeningStarted.promise;
    await vi.advanceTimersByTimeAsync(3_000);

    assert.equal(startupSettled, false);
    expect(warning).toHaveBeenCalledTimes(1);
    assert.match(
      String(warning.mock.calls[0]?.[0]),
      /^Fragno outbox browser persistence is still opening after 3000ms\..*Initialization will keep waiting\.$/,
    );
    const expectedDiagnostics = {
      databaseName: "fragno-test.sqlite",
      elapsedMs: 3_000,
      timerDriftMs: 0,
      workerProbe: {
        status: "unsupported",
      },
      runtime: {
        opfsAvailable: false,
      },
    };
    expect(warning.mock.calls[0]?.[1]).toMatchObject(expectedDiagnostics);
    expect(diagnosticsReported).toHaveLength(1);
    expect(diagnosticsReported[0]).toMatchObject(expectedDiagnostics);

    persistenceOpening.resolve({ opened: true });
    await expect(startupPromise).resolves.toEqual({ opened: true });
  });

  it("keeps reporting diagnostics when a browser inspection stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", undefined);
    const queryLocks = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal("navigator", { locks: { query: queryLocks } });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const persistenceOpening = Promise.withResolvers<{ opened: true }>();
    const diagnosticsReported: unknown[] = [];
    const startupPromise = openFragnoBrowserPersistenceWithDiagnostics({
      databaseName: "fragno-test.sqlite",
      onDiagnostic(diagnostics) {
        diagnosticsReported.push(diagnostics);
      },
      openPersistence() {
        return persistenceOpening.promise;
      },
    });

    await vi.advanceTimersByTimeAsync(4_000);

    expect(diagnosticsReported).toHaveLength(1);
    expect(diagnosticsReported[0]).toMatchObject({
      webLocks: {
        status: "failed",
        error: "Web Locks inspection timed out after 1000ms.",
      },
    });

    await vi.advanceTimersByTimeAsync(4_000);

    expect(warning).toHaveBeenCalledTimes(2);
    expect(diagnosticsReported).toHaveLength(2);
    expect(queryLocks).toHaveBeenCalledTimes(1);

    persistenceOpening.resolve({ opened: true });
    await expect(startupPromise).resolves.toEqual({ opened: true });
  });

  it("opens persistence while the dedicated worker probe is still starting", async () => {
    class DelayedWorkerProbe extends EventTarget {
      static readonly instances: DelayedWorkerProbe[] = [];
      terminated = false;

      constructor(_scriptUrl: string | URL) {
        super();
        DelayedWorkerProbe.instances.push(this);
      }

      terminate() {
        this.terminated = true;
      }
    }

    vi.stubGlobal("Worker", DelayedWorkerProbe);
    const persistenceOpening = Promise.withResolvers<{ opened: true }>();
    const persistenceOpeningStarted = Promise.withResolvers<void>();
    let persistenceOpenCalls = 0;
    const startupPromise = openFragnoBrowserPersistenceWithDiagnostics({
      databaseName: "fragno-test.sqlite",
      onDiagnostic: null,
      openPersistence() {
        persistenceOpenCalls += 1;
        persistenceOpeningStarted.resolve();
        return persistenceOpening.promise;
      },
    });

    await persistenceOpeningStarted.promise;
    assert.equal(DelayedWorkerProbe.instances.length, 1);
    assert.equal(persistenceOpenCalls, 1);
    assert.equal(DelayedWorkerProbe.instances[0]!.terminated, false);

    persistenceOpening.resolve({ opened: true });
    await expect(startupPromise).resolves.toEqual({ opened: true });
    assert.equal(DelayedWorkerProbe.instances[0]!.terminated, true);
  });
});
