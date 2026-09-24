import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import v8 from "node:v8";

import type { ServerMemoryMetrics, ServerMemorySample } from "./server-benchmark-metrics";

type ServerMemoryMeasurementOptions = {
  profile: boolean;
  profileFilePath: string;
  allocationSampleIntervalBytes: number;
  memorySampleIntervalMs: number;
};

type ActiveServerMemoryMeasurement = {
  finish: () => Promise<MeasuredServerMemory>;
  abort: () => Promise<void>;
};

type MeasuredServerMemory = Omit<
  ServerMemoryMetrics,
  "retainedHeapUsedBytes" | "retainedHeapDeltaBytes" | "retainedRssBytes"
> & {
  durationMs: number;
  profile: { kind: "disabled" } | { kind: "written"; filePath: string };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Force post-workload garbage collection so retained server memory is measured consistently. */
export async function forceServerGarbageCollection(): Promise<void> {
  if (typeof globalThis.gc !== "function") {
    throw new Error("Server benchmark requires Node.js --expose-gc.");
  }
  for (let pass = 0; pass < 3; pass += 1) {
    globalThis.gc();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** Measure only the current server process until finish is called before client teardown. */
export function startServerMemoryMeasurement(
  options: ServerMemoryMeasurementOptions,
): ActiveServerMemoryMeasurement {
  const baseline = process.memoryUsage();
  const started = performance.now();
  const timeline: ServerMemorySample[] = [
    {
      elapsedMs: 0,
      heapUsedBytes: baseline.heapUsed,
      rssBytes: baseline.rss,
      externalBytes: baseline.external,
    },
  ];
  let peakHeapUsedBytes = baseline.heapUsed;
  let peakRssBytes = baseline.rss;
  let peakExternalBytes = baseline.external;
  let sampling = true;
  let stopped = false;
  const sampler = (async () => {
    while (sampling) {
      const memory = process.memoryUsage();
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
      peakRssBytes = Math.max(peakRssBytes, memory.rss);
      peakExternalBytes = Math.max(peakExternalBytes, memory.external);
      timeline.push({
        elapsedMs: performance.now() - started,
        heapUsedBytes: memory.heapUsed,
        rssBytes: memory.rss,
        externalBytes: memory.external,
      });
      await sleep(options.memorySampleIntervalMs);
    }
  })();
  const heapProfile = options.profile
    ? v8.startHeapProfile({
        sampleInterval: options.allocationSampleIntervalBytes,
        stackDepth: 64,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      })
    : null;

  async function stopSampler(): Promise<{
    durationMs: number;
    finalMemory: NodeJS.MemoryUsage;
  }> {
    if (stopped) {
      throw new Error("Server memory measurement was already stopped.");
    }
    stopped = true;
    sampling = false;
    await sampler;
    const durationMs = performance.now() - started;
    const finalMemory = process.memoryUsage();
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, finalMemory.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, finalMemory.rss);
    peakExternalBytes = Math.max(peakExternalBytes, finalMemory.external);
    timeline.push({
      elapsedMs: durationMs,
      heapUsedBytes: finalMemory.heapUsed,
      rssBytes: finalMemory.rss,
      externalBytes: finalMemory.external,
    });
    return { durationMs, finalMemory };
  }

  return {
    finish: async function finishServerMemoryMeasurement(): Promise<MeasuredServerMemory> {
      const { durationMs, finalMemory } = await stopSampler();
      let profile: MeasuredServerMemory["profile"] = { kind: "disabled" };
      if (heapProfile) {
        const profileData = heapProfile.stop();
        await mkdir(path.dirname(options.profileFilePath), { recursive: true });
        await writeFile(options.profileFilePath, profileData);
        console.error(`Heap profile written to ${options.profileFilePath}`);
        profile = { kind: "written", filePath: options.profileFilePath };
      }
      return {
        durationMs,
        baselineHeapUsedBytes: baseline.heapUsed,
        peakHeapUsedBytes,
        peakHeapDeltaBytes: peakHeapUsedBytes - baseline.heapUsed,
        baselineRssBytes: baseline.rss,
        peakRssBytes,
        peakRssDeltaBytes: peakRssBytes - baseline.rss,
        baselineExternalBytes: baseline.external,
        peakExternalBytes,
        peakExternalDeltaBytes: peakExternalBytes - baseline.external,
        postWorkloadHeapUsedBytes: finalMemory.heapUsed,
        timeline,
        profile,
      };
    },
    abort: async function abortServerMemoryMeasurement(): Promise<void> {
      if (!stopped) {
        await stopSampler();
        heapProfile?.stop();
      }
    },
  };
}

/** Add retained process metrics after the unmeasured client and transport have been closed. */
export async function measureRetainedServerMemory(
  measured: MeasuredServerMemory,
): Promise<ServerMemoryMetrics> {
  await forceServerGarbageCollection();
  const retained = process.memoryUsage();
  const { durationMs: _durationMs, profile: _profile, ...memory } = measured;
  return {
    ...memory,
    retainedHeapUsedBytes: retained.heapUsed,
    retainedHeapDeltaBytes: retained.heapUsed - measured.baselineHeapUsedBytes,
    retainedRssBytes: retained.rss,
  };
}
