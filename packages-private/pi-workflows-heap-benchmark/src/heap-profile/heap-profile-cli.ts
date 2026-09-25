import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareServerBenchmarkWorkloads,
  parseServerBenchmarkMetrics,
  type ServerBenchmarkMetrics,
} from "../benchmark-runtime/server-benchmark-metrics";
import { analyzeHeapAllocationProfile, type HeapAllocationAnalysis } from "./heap-profile-analysis";
import { createHeapProfileSourceResolver } from "./heap-profile-source-locations";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const usage = `Usage:
  pnpm analyze report <file.heapprofile> [--metrics run.benchmark-metrics.json] [--json]
  pnpm analyze compare <baseline.heapprofile> <candidate.heapprofile> [--baseline-metrics run.benchmark-metrics.json] [--candidate-metrics run.benchmark-metrics.json] [--json]

If no metrics path is supplied, the CLI looks beside each profile for a matching .benchmark-metrics.json.`;

type ProfileReport = {
  file: string;
  allocations: HeapAllocationAnalysis;
  metrics: ServerBenchmarkMetrics | null;
};

function readProfileMetrics(
  profilePath: string,
  metricsPath: string | null,
): ServerBenchmarkMetrics | null {
  const inferred = profilePath.replace(/\.heapprofile$/, ".benchmark-metrics.json");
  const sidecar = metricsPath ?? (existsSync(inferred) ? inferred : null);
  return sidecar ? parseServerBenchmarkMetrics(JSON.parse(readFileSync(sidecar, "utf8"))) : null;
}

function analyzeProfile(profilePath: string, metricsPath: string | null): ProfileReport {
  const file = path.resolve(profilePath);
  const allocations = analyzeHeapAllocationProfile(
    JSON.parse(readFileSync(file, "utf8")),
    createHeapProfileSourceResolver(repositoryRoot),
  );
  return { file, allocations, metrics: readProfileMetrics(file, metricsPath) };
}

function mib(bytes: number): string {
  return `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}

function formatAllocationGroups(
  heading: string,
  groups: HeapAllocationAnalysis["selfAllocators"],
  total: number,
): string[] {
  return [
    `${heading}:`,
    ...groups
      .slice(0, 10)
      .map(
        ({ label, bytes, samples }) =>
          `  ${mib(bytes).padStart(11)}  ${(total ? (bytes / total) * 100 : 0).toFixed(1).padStart(5)}%  ${String(samples).padStart(5)} samples  ${label}`,
      ),
  ];
}

function formatBenchmarkWorkload(metrics: ServerBenchmarkMetrics): string[] {
  const lines = [
    `Workload: ${metrics.kind}, ${metrics.outboxMode}, Node ${metrics.nodeVersion}, ${(metrics.durationMs / 1_000).toFixed(1)} s.`,
    `Server peaks: heap ${mib(metrics.peakHeapUsedBytes)}, RSS ${mib(metrics.peakRssBytes)}, external ${mib(metrics.peakExternalBytes)}.`,
  ];
  if (metrics.kind === "pi-workflow") {
    lines.push(
      `Workflow: ${metrics.modelId}, ${metrics.outboxEntriesRead} outbox entries, final status ${metrics.status.status}.`,
    );
  } else {
    const databaseReads =
      metrics.outboxDatabaseReadCount === null
        ? "database reads unavailable"
        : `${metrics.outboxDatabaseReadCount} outbox database reads`;
    const lagging =
      metrics.laggingClientCount === 0
        ? "no lagging clients"
        : `${metrics.laggingEntriesConsumed} entries consumed by ${metrics.laggingClientCount} lagging clients (${metrics.laggingEntriesConsumedByClient.join(", ")} per client)`;
    lines.push(
      `Outbox (${metrics.scenario}): ${metrics.entryCount} entries × ${metrics.clientCount} current clients, ${mib(metrics.payloadBytesConsumed)} aggregate payload, checksum ${metrics.checksum}, ${lagging}, ${databaseReads}.`,
    );
  }
  const peak = metrics.timeline.reduce((largest, sample) =>
    sample.heapUsedBytes > largest.heapUsedBytes ? sample : largest,
  );
  lines.push(
    `Memory timeline: ${metrics.timeline.length} samples; V8 heap peak ${mib(peak.heapUsedBytes)} at ${(peak.elapsedMs / 1_000).toFixed(1)} s.`,
  );
  return lines;
}

function formatProfileReport(report: ProfileReport): string {
  const { allocations, metrics } = report;
  const lines = [
    report.file,
    `Sampled allocations: ${mib(allocations.sampledBytes)} (${allocations.samples} samples); unattributed to project: ${mib(allocations.unattributedBytes)}.`,
    `Unresolved node IDs: ${allocations.unresolvedSamples} samples, ${mib(allocations.unresolvedBytes)}; call-tree self-size total: ${mib(allocations.treeSelfBytes)} (independent accounting).`,
    ...(metrics ? formatBenchmarkWorkload(metrics) : []),
    ...formatAllocationGroups(
      "Self allocators (exclusive)",
      allocations.selfAllocators,
      allocations.resolvedBytes,
    ),
    ...formatAllocationGroups(
      "Allocation modules (exclusive)",
      allocations.modules,
      allocations.resolvedBytes,
    ),
    ...formatAllocationGroups(
      "Nearest project callers (exclusive ownership)",
      allocations.projectOwners,
      allocations.resolvedBytes,
    ),
    ...formatAllocationGroups(
      "Project frames (inclusive; rows overlap)",
      allocations.inclusiveProjectFrames,
      allocations.resolvedBytes,
    ),
    ...formatAllocationGroups(
      "Project caller ← allocating frame",
      allocations.ownedCallPaths,
      allocations.resolvedBytes,
    ),
  ];
  return lines.join("\n");
}

function formatProfileComparison(baseline: ProfileReport, candidate: ProfileReport): string {
  const workload = compareServerBenchmarkWorkloads(baseline.metrics, candidate.metrics);
  const deltaBytes = candidate.allocations.sampledBytes - baseline.allocations.sampledBytes;
  const lines = [
    `Baseline:  ${baseline.file}`,
    `Candidate: ${candidate.file}`,
    `Workload comparability: ${workload.status.toUpperCase()}${workload.status === "matched" ? " (single run pair; repeat to establish a trend)" : " (allocation differences are descriptive, not a winner)"}`,
    ...workload.warnings.map((warning) => `  ! ${warning}`),
    `Total sampled: ${mib(baseline.allocations.sampledBytes)} → ${mib(candidate.allocations.sampledBytes)} (${deltaBytes >= 0 ? "+" : ""}${mib(deltaBytes)}).`,
  ];
  if (baseline.metrics && candidate.metrics) {
    lines.push(
      `Peak V8 heap: ${mib(baseline.metrics.peakHeapUsedBytes)} → ${mib(candidate.metrics.peakHeapUsedBytes)}.`,
      `Peak RSS: ${mib(baseline.metrics.peakRssBytes)} → ${mib(candidate.metrics.peakRssBytes)}.`,
      `Peak external: ${mib(baseline.metrics.peakExternalBytes)} → ${mib(candidate.metrics.peakExternalBytes)}.`,
    );
  }

  const previousOwners = new Map(
    baseline.allocations.projectOwners.map(({ label, bytes }) => [label, bytes]),
  );
  const increased = candidate.allocations.projectOwners
    .map(({ label, bytes }) => ({ label, before: previousOwners.get(label) ?? 0, after: bytes }))
    .filter(({ before, after }) => after > before)
    .sort((a, b) => b.after - b.before - (a.after - a.before));
  lines.push(
    "Project caller allocation increases (absolute; check workload comparability above):",
    ...increased
      .slice(0, 10)
      .map(
        ({ label, before, after }) =>
          `  +${mib(after - before).padStart(11)}  ${mib(before)} → ${mib(after)}  ${label}`,
      ),
  );
  return lines.join("\n");
}

function parseOptions(args: string[], validFlags: string[]) {
  const files: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      flags.set(argument, "true");
      continue;
    }
    if (argument?.startsWith("--")) {
      if (
        !validFlags.includes(argument) ||
        flags.has(argument) ||
        !args[index + 1] ||
        args[index + 1]?.startsWith("--")
      ) {
        throw new Error(`Invalid heap profile analyzer option: ${argument}`);
      }
      flags.set(argument, args[++index]);
    } else if (argument) {
      files.push(argument);
    }
  }
  return { files, flags };
}

function runHeapProfileCli(): void {
  const [command, ...args] = process.argv.slice(2).filter((argument) => argument !== "--");
  if (command === "--help" || command === undefined) {
    console.log(usage);
    return;
  }
  if (command === "report") {
    const { files, flags } = parseOptions(args, ["--metrics"]);
    if (files.length !== 1) {
      throw new Error(usage);
    }
    const report = analyzeProfile(files[0], flags.get("--metrics") ?? null);
    console.log(
      flags.has("--json") ? JSON.stringify(report, null, 2) : formatProfileReport(report),
    );
    return;
  }
  if (command === "compare") {
    const { files, flags } = parseOptions(args, ["--baseline-metrics", "--candidate-metrics"]);
    if (files.length !== 2) {
      throw new Error(usage);
    }
    const baseline = analyzeProfile(files[0], flags.get("--baseline-metrics") ?? null);
    const candidate = analyzeProfile(files[1], flags.get("--candidate-metrics") ?? null);
    const workload = compareServerBenchmarkWorkloads(baseline.metrics, candidate.metrics);
    console.log(
      flags.has("--json")
        ? JSON.stringify({ baseline, candidate, workload }, null, 2)
        : formatProfileComparison(baseline, candidate),
    );
    return;
  }
  throw new Error(usage);
}

try {
  runHeapProfileCli();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
