import { assert, expect, it } from "vitest";

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = fileURLToPath(new URL("../../", import.meta.url));
const sourceFile = fileURLToPath(
  new URL("../../../../packages/fragno-db/src/outbox/assemble-outbox-entry.ts", import.meta.url),
);

function workflowMetrics(mode: "poll" | "stream", outboxEntriesRead: number) {
  return {
    kind: "pi-workflow",
    provider: "recorded:openai",
    modelId: "test-model@4x",
    nodeVersion: "v26.10.0",
    outboxMode: mode,
    transport: "node-http",
    measurementScope: "server",
    outboxEntriesRead,
    durationMs: 20_000,
    baselineHeapUsedBytes: 100,
    peakHeapUsedBytes: 300,
    peakHeapDeltaBytes: 200,
    baselineRssBytes: 1_000,
    peakRssBytes: 1_400,
    peakRssDeltaBytes: 400,
    baselineExternalBytes: 10,
    peakExternalBytes: 20,
    peakExternalDeltaBytes: 10,
    postWorkloadHeapUsedBytes: 250,
    retainedHeapUsedBytes: 120,
    retainedHeapDeltaBytes: 20,
    retainedRssBytes: 1_100,
    status: { status: "waiting", runGeneration: 1 },
    timeline: [
      { elapsedMs: 0, heapUsedBytes: 100, rssBytes: 1_000, externalBytes: 10 },
      { elapsedMs: 2_000, heapUsedBytes: 300, rssBytes: 1_400, externalBytes: 20 },
    ],
  };
}

it("reports and compares server heap profiles with canonical metric sidecars", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "fragno-heap-cli-"));
  try {
    const paths = (["poll", "stream"] as const).map((mode, index) => {
      const profile = path.join(directory, `${mode}.heapprofile`);
      const input = {
        head: {
          id: 1,
          selfSize: 0,
          callFrame: { functionName: "root", url: "", lineNumber: 0, columnNumber: 0 },
          children: [
            {
              id: 2,
              selfSize: 100 + index * 20,
              callFrame: {
                functionName: "assembleOutboxEntry",
                url: pathToFileURL(sourceFile).href,
                lineNumber: 5,
                columnNumber: 16,
              },
              children: [],
            },
          ],
        },
        samples: [{ nodeId: 2, size: 100 + index * 20, ordinal: 1 }],
      };
      writeFileSync(profile, JSON.stringify(input));
      writeFileSync(
        profile.replace(/\.heapprofile$/, ".benchmark-metrics.json"),
        JSON.stringify(workflowMetrics(mode, 100 + index * 50)),
      );
      return profile;
    });

    const report = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/heap-profile/heap-profile-cli.ts", "report", paths[0], "--json"],
        { cwd: packageDirectory, encoding: "utf8" },
      ),
    ) as { allocations: { sampledBytes: number; projectOwners: Array<{ label: string }> } };
    assert(report.allocations.sampledBytes === 100);
    expect(report.allocations.projectOwners[0]?.label).toContain(
      "packages/fragno-db/src/outbox/assemble-outbox-entry.ts",
    );

    const readable = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/heap-profile/heap-profile-cli.ts", "report", paths[0]],
      { cwd: packageDirectory, encoding: "utf8" },
    );
    expect(readable).toContain("Memory timeline: 2 samples; V8 heap peak 0.0 MiB at 2.0 s.");

    const comparison = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/heap-profile/heap-profile-cli.ts",
          "compare",
          paths[0],
          paths[1],
          "--json",
        ],
        { cwd: packageDirectory, encoding: "utf8" },
      ),
    ) as { workload: { status: string; warnings: string[] } };
    assert(comparison.workload.status === "mismatched");
    expect(comparison.workload.warnings).toContain("Outbox entries read differs by more than 5%.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
