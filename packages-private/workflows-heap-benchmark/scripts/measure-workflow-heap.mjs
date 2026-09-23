import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOptions = {
  mode: "both",
  histories: [100, 10_000],
  runs: 1,
  batchCount: 30,
  emissionsPerBatch: 10,
  payloadBytes: 256,
  intervalMs: 125,
  jsonPath: null,
  workerPort: null,
  inspectorPort: null,
};
const commandTimeoutMs = 30_000;
const serverStartupTimeoutMs = 45_000;
const heapPollIntervalMs = 10;

function parseArguments(args) {
  const parsed = { ...defaultOptions };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printUsage();
      process.exit(0);
    }

    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${argument}`);
    }
    index += 1;

    switch (argument) {
      case "--mode":
        if (!new Set(["heap", "allocation", "both"]).has(value)) {
          throw new Error("--mode must be heap, allocation, or both");
        }
        parsed.mode = value;
        break;
      case "--histories":
        parsed.histories = value
          .split(",")
          .map((item) => parsePositiveInteger(item, argument, true));
        break;
      case "--runs":
        parsed.runs = parsePositiveInteger(value, argument);
        break;
      case "--batch-count":
        parsed.batchCount = parsePositiveInteger(value, argument);
        break;
      case "--emissions-per-batch":
        parsed.emissionsPerBatch = parsePositiveInteger(value, argument);
        break;
      case "--payload-bytes":
        parsed.payloadBytes = parsePositiveInteger(value, argument, true);
        break;
      case "--interval-ms":
        parsed.intervalMs = parsePositiveInteger(value, argument, true);
        break;
      case "--json":
        parsed.jsonPath = value;
        break;
      case "--worker-port":
        parsed.workerPort = parsePositiveInteger(value, argument);
        break;
      case "--inspector-port":
        parsed.inspectorPort = parsePositiveInteger(value, argument);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (parsed.histories.length === 0) {
    throw new Error("--histories requires at least one count");
  }
  return parsed;
}

function parsePositiveInteger(value, name, allowZero = false) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage: pnpm measure -- [options]

Options:
  --mode <heap|allocation|both>  Measurement mode (default: both)
  --histories <counts>           Comma-separated historical emission counts
  --runs <count>                 Fresh Workerd processes per case (default: 1)
  --batch-count <count>          Measured emission batches (default: 30)
  --emissions-per-batch <count>  Emissions per batch (default: 10)
  --payload-bytes <count>        Payload string size (default: 256)
  --interval-ms <count>          Delay between batches (default: 125)
  --json <path>                  Write the complete report as JSON
  --worker-port <port>           Wrangler HTTP port (default: automatically selected)
  --inspector-port <port>        Workerd inspector port (default: automatically selected)`);
}

async function runMeasurements(measurementOptions) {
  const modes =
    measurementOptions.mode === "both" ? ["heap", "allocation"] : [measurementOptions.mode];
  const results = [];

  for (const mode of modes) {
    for (const historicalEmissionCount of measurementOptions.histories) {
      for (let run = 1; run <= measurementOptions.runs; run += 1) {
        console.error(
          `Running ${mode} measurement: history=${historicalEmissionCount}, run=${run}/${measurementOptions.runs}`,
        );
        results.push(
          await runOneMeasurement({
            ...measurementOptions,
            mode,
            historicalEmissionCount,
            run,
          }),
        );
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    wranglerVersion: await readWranglerVersion(),
    options: {
      mode: measurementOptions.mode,
      histories: measurementOptions.histories,
      runs: measurementOptions.runs,
      batchCount: measurementOptions.batchCount,
      emissionsPerBatch: measurementOptions.emissionsPerBatch,
      payloadBytes: measurementOptions.payloadBytes,
      intervalMs: measurementOptions.intervalMs,
    },
    results,
    medians: calculateMedians(results),
  };
}

async function runOneMeasurement(optionsForRun) {
  const ports = await resolveRunPorts(optionsForRun);
  const runOptions = { ...optionsForRun, ...ports };
  const persistenceDirectory = await mkdtemp(
    path.join(tmpdir(), "fragno-workflows-heap-benchmark-"),
  );
  const server = startWrangler(runOptions, persistenceDirectory);
  const benchmarkId = `${runOptions.mode}-${runOptions.historicalEmissionCount}-${runOptions.run}-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${runOptions.workerPort}`;

  try {
    await waitForServer(`${baseUrl}/health`, server);
    await fetchJson(`${baseUrl}/prepare?benchmarkId=${encodeURIComponent(benchmarkId)}`, {
      method: "POST",
      body: JSON.stringify({
        historicalEmissionCount: runOptions.historicalEmissionCount,
        batchCount: runOptions.batchCount,
        emissionsPerBatch: runOptions.emissionsPerBatch,
        payloadBytes: runOptions.payloadBytes,
        intervalMs: runOptions.intervalMs,
      }),
    });

    const target = await waitForInspectorTarget(runOptions.inspectorPort, server);
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();

    try {
      await client.send("Runtime.enable");
      await client.send("HeapProfiler.enable");
      await client.send("Runtime.discardConsoleEntries");
      await delay(250);

      const measurement =
        runOptions.mode === "heap"
          ? await measureHeap(client, async () =>
              fetchJson(`${baseUrl}/run?benchmarkId=${encodeURIComponent(benchmarkId)}`, {
                method: "POST",
              }),
            )
          : await measureAllocation(client, async () =>
              fetchJson(`${baseUrl}/run?benchmarkId=${encodeURIComponent(benchmarkId)}`, {
                method: "POST",
              }),
            );
      const result = await fetchJson(
        `${baseUrl}/result?benchmarkId=${encodeURIComponent(benchmarkId)}`,
      );
      assertBenchmarkResult(result, runOptions);

      return {
        mode: runOptions.mode,
        historicalEmissionCount: runOptions.historicalEmissionCount,
        run: runOptions.run,
        measurement,
        result,
      };
    } finally {
      client.close();
    }
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nWrangler output:\n${server.output()}`,
    );
  } finally {
    await server.stop();
    await rm(persistenceDirectory, { recursive: true, force: true });
  }
}

async function resolveRunPorts(optionsForRun) {
  const workerPort =
    optionsForRun.workerPort ?? (await findAvailablePort(new Set([optionsForRun.inspectorPort])));
  if (optionsForRun.workerPort !== null) {
    await assertPortAvailable(workerPort, "Wrangler HTTP port");
  }

  const inspectorPort =
    optionsForRun.inspectorPort ?? (await findAvailablePort(new Set([workerPort])));
  if (inspectorPort === workerPort) {
    throw new Error("Wrangler HTTP and Workerd inspector ports must be different");
  }
  if (optionsForRun.inspectorPort !== null) {
    await assertPortAvailable(inspectorPort, "Workerd inspector port");
  }

  return { workerPort, inspectorPort };
}

async function findAvailablePort(excludedPorts) {
  while (true) {
    const port = await probeAvailablePort(0);
    if (!excludedPorts.has(port)) {
      return port;
    }
  }
}

async function assertPortAvailable(port, label) {
  try {
    await probeAvailablePort(port);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
      throw new Error(`${label} ${port} is already in use`);
    }
    throw error;
  }
}

function probeAvailablePort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to resolve an available TCP port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

function startWrangler(optionsForRun, persistenceDirectory) {
  const wranglerExecutable = path.join(packageDirectory, "node_modules", ".bin", "wrangler");
  const child = spawn(
    wranglerExecutable,
    [
      "dev",
      "--local",
      "--port",
      String(optionsForRun.workerPort),
      "--inspector-port",
      String(optionsForRun.inspectorPort),
      "--persist-to",
      persistenceDirectory,
      "--log-level",
      "error",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: packageDirectory,
      detached: process.platform !== "win32",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const appendOutput = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-40_000);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  return {
    child,
    output: () => output,
    async stop() {
      signalProcessTree(child, "SIGTERM");
      await Promise.race([waitForChildExit(child), delay(2_000)]);
      signalProcessTree(child, "SIGKILL");
      await Promise.race([waitForChildExit(child), delay(1_000)]);
    },
  };
}

function signalProcessTree(child, signal) {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

async function waitForServer(healthUrl, server) {
  const deadline = Date.now() + serverStartupTimeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Wrangler exited before becoming ready with code ${server.child.exitCode}`);
    }
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        await delay(50);
        if (server.child.exitCode !== null) {
          throw new Error(
            `Wrangler exited after opening its HTTP port with code ${server.child.exitCode}`,
          );
        }
        return;
      }
    } catch {
      // Retry until the startup deadline.
    }
    await delay(200);
  }
  throw new Error(`Wrangler did not become ready within ${serverStartupTimeoutMs}ms`);
}

async function waitForInspectorTarget(inspectorPort, server) {
  const deadline = Date.now() + serverStartupTimeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `Wrangler exited before its inspector became ready with code ${server.child.exitCode}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const target = Array.isArray(targets)
          ? targets.find(
              (candidate) =>
                typeof candidate === "object" &&
                candidate !== null &&
                typeof candidate.webSocketDebuggerUrl === "string",
            )
          : undefined;
        if (target) {
          return target;
        }
      }
    } catch {
      // Retry until Wrangler exposes its Workerd inspector target.
    }
    await delay(100);
  }
  throw new Error(`Workerd inspector did not become ready within ${serverStartupTimeoutMs}ms`);
}

async function measureHeap(client, run) {
  const baseline = await client.send("Runtime.getHeapUsage");
  let peakUsedSize = baseline.usedSize;
  let stopped = false;
  const poller = (async () => {
    while (!stopped) {
      const sample = await client.send("Runtime.getHeapUsage");
      peakUsedSize = Math.max(peakUsedSize, sample.usedSize);
      await delay(heapPollIntervalMs);
    }
  })();

  const startedAt = performance.now();
  let runResult;
  try {
    runResult = await run();
  } finally {
    stopped = true;
    await poller;
  }
  const completed = await client.send("Runtime.getHeapUsage");
  peakUsedSize = Math.max(peakUsedSize, completed.usedSize);
  await client.send("Runtime.discardConsoleEntries");
  await delay(250);
  const settled = await client.send("Runtime.getHeapUsage");

  return {
    durationMs: performance.now() - startedAt,
    baselineUsedBytes: baseline.usedSize,
    peakUsedBytes: peakUsedSize,
    peakDeltaBytes: peakUsedSize - baseline.usedSize,
    completedUsedBytes: completed.usedSize,
    settledUsedBytes: settled.usedSize,
    settledDeltaBytes: settled.usedSize - baseline.usedSize,
    runResult,
  };
}

async function measureAllocation(client, run) {
  await client.send("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const startedAt = performance.now();
  const runResult = await run();
  const { profile } = await client.send("HeapProfiler.stopSampling", {}, 120_000);
  const summary = summarizeAllocationProfile(profile);

  return {
    durationMs: performance.now() - startedAt,
    sampledAllocationBytes: summary.sampledAllocationBytes,
    topCallFrames: summary.topCallFrames,
    runResult,
  };
}

function summarizeAllocationProfile(profile) {
  const callFrames = new Map();
  const visit = (node) => {
    callFrames.set(node.id, node.callFrame);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(profile.head);

  const allocations = new Map();
  let sampledAllocationBytes = 0;
  for (const sample of profile.samples ?? []) {
    sampledAllocationBytes += sample.size;
    const frame = callFrames.get(sample.nodeId) ?? {};
    const label = `${frame.functionName || "(anonymous)"} ${frame.url || ""}:${
      (frame.lineNumber ?? -1) + 1
    }`;
    allocations.set(label, (allocations.get(label) ?? 0) + sample.size);
  }

  return {
    sampledAllocationBytes,
    topCallFrames: [...allocations]
      .map(([callFrame, bytes]) => ({ callFrame, bytes }))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 20),
  };
}

function assertBenchmarkResult(result, optionsForRun) {
  const expectedEmittedCount = optionsForRun.batchCount * optionsForRun.emissionsPerBatch;
  const output = result?.status?.output;
  if (result?.status?.status !== "complete") {
    throw new Error(`Benchmark result was not complete: ${JSON.stringify(result)}`);
  }
  if (output?.emittedCount !== expectedEmittedCount) {
    throw new Error(`Benchmark emitted ${output?.emittedCount}; expected ${expectedEmittedCount}`);
  }
  if (output?.emittedPayloadBytes !== expectedEmittedCount * optionsForRun.payloadBytes) {
    throw new Error("Benchmark emitted payload byte count did not match its input");
  }
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Request returned invalid JSON (${response.status}): ${text}`);
  }
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function readWranglerVersion() {
  return await new Promise((resolveVersion, rejectVersion) => {
    const child = spawn("pnpm", ["exec", "wrangler", "--version"], {
      cwd: packageDirectory,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", rejectVersion);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveVersion(output.trim());
      } else {
        rejectVersion(new Error(`Unable to read Wrangler version: ${output}`));
      }
    });
  });
}

function calculateMedians(results) {
  const grouped = new Map();
  for (const result of results) {
    const key = `${result.mode}:${result.historicalEmissionCount}`;
    const group = grouped.get(key) ?? [];
    group.push(result);
    grouped.set(key, group);
  }

  return [...grouped].map(([key, group]) => {
    const [mode, historicalEmissionCount] = key.split(":");
    return {
      mode,
      historicalEmissionCount: Number(historicalEmissionCount),
      runCount: group.length,
      durationMs: median(group.map((result) => result.measurement.durationMs)),
      ...(mode === "heap"
        ? {
            peakDeltaBytes: median(group.map((result) => result.measurement.peakDeltaBytes)),
            settledDeltaBytes: median(group.map((result) => result.measurement.settledDeltaBytes)),
          }
        : {
            sampledAllocationBytes: median(
              group.map((result) => result.measurement.sampledAllocationBytes),
            ),
          }),
    };
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function printReport(report) {
  console.log("\nWorkflow heap benchmark");
  console.log(`Wrangler: ${report.wranglerVersion}`);
  for (const result of report.medians) {
    if (result.mode === "heap") {
      console.log(
        `heap history=${result.historicalEmissionCount} runs=${result.runCount} ` +
          `peakDelta=${formatBytes(result.peakDeltaBytes)} ` +
          `settledDelta=${formatBytes(result.settledDeltaBytes)} ` +
          `duration=${result.durationMs.toFixed(1)}ms`,
      );
    } else {
      console.log(
        `allocation history=${result.historicalEmissionCount} runs=${result.runCount} ` +
          `sampled=${formatBytes(result.sampledAllocationBytes)} ` +
          `duration=${result.durationMs.toFixed(1)}ms`,
      );
    }
  }
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketDebuggerUrl, { origin: "http://localhost" });
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
    this.socket.on("close", () => {
      this.rejectPending(new Error("Workerd inspector connection closed"));
    });
    this.socket.on("error", (error) => {
      this.rejectPending(error);
    });
    await new Promise((resolveConnection, rejectConnection) => {
      this.socket.once("open", resolveConnection);
      this.socket.once("error", rejectConnection);
      this.socket.once("unexpected-response", (_request, response) => {
        rejectConnection(new Error(`Inspector rejected WebSocket: HTTP ${response.statusCode}`));
      });
    });
  }

  send(method, params = {}, timeoutMs = commandTimeoutMs) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Cannot send ${method}: Workerd inspector is not connected`));
    }
    const id = ++this.nextId;
    return new Promise((resolveCommand, rejectCommand) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolveCommand,
        reject: rejectCommand,
        timeout,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.socket.close();
  }
}

const options = parseArguments(process.argv.slice(2));
const report = await runMeasurements(options);
printReport(report);

if (options.jsonPath) {
  const outputPath = path.resolve(options.jsonPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(process.cwd(), outputPath)}`);
}
