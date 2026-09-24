#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import WebSocket from "ws";

const PI_WORKFLOW_NAME = "interactive-chat-workflow";
const STREAMING_COMPLETED = "fragno.workflow_step_emissions.completed";
const CLEANUP_STARTED = "fragno.workflow_step_emissions_cleanup.started";
const CLEANUP_COMPLETED = "fragno.workflow_step_emissions_cleanup.completed";
const SAMPLE_INTERVAL_MS = 100;
const COMMAND_TIMEOUT_MS = 180_000;

function usage() {
  return `Usage: node apps/backoffice/scripts/profile-streaming-heap.mjs --mode sampled|heap-only --output /tmp/heap-run [--post-ms 30000] [--marker-timeout-ms 180000] -- <turn command and args>

Run against a production build served by Vite preview with one outbox listener and one active turn.
Requires WORKERD_CDP_URL (default http://localhost:9229), BACKOFFICE_URL, and valid CLI credentials.
The command must finish a workflow step and trigger its step-emission cleanup before the marker deadline.
Writes .summary.json, .memory.tsv, .stdout, .stderr, and per-phase .allocation.json files.
Do not compare sampled-run peak heap with heap-only-run peak heap.`;
}

function parseArguments(args) {
  const separator = args.indexOf("--");
  const options = args.slice(0, separator);
  const command = args.slice(separator + 1);
  if (separator < 0 || command.length === 0) {
    throw new Error(usage());
  }
  const getValue = (flag) => {
    const index = options.indexOf(flag);
    if (index < 0 || !options[index + 1]) {
      throw new Error(`${flag} is required\n${usage()}`);
    }
    return options[index + 1];
  };
  const mode = getValue("--mode");
  if (mode !== "sampled" && mode !== "heap-only") {
    throw new Error(usage());
  }
  const postOption = options.indexOf("--post-ms");
  const postMs = postOption < 0 ? 30_000 : Number(options[postOption + 1]);
  if (!Number.isSafeInteger(postMs) || postMs < 0) {
    throw new Error("--post-ms must be a nonnegative integer");
  }
  const markerOption = options.indexOf("--marker-timeout-ms");
  const markerTimeoutMs = markerOption < 0 ? 180_000 : Number(options[markerOption + 1]);
  if (!Number.isSafeInteger(markerTimeoutMs) || markerTimeoutMs <= 0) {
    throw new Error("--marker-timeout-ms must be a positive integer");
  }
  return { mode, output: resolve(getValue("--output")), postMs, markerTimeoutMs, command };
}

class InspectorClient {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.onConsole = () => {};
  }

  async connect() {
    this.socket = new WebSocket(this.url, { origin: "http://localhost" });
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.method === "Runtime.consoleAPICalled") {
        this.onConsole(message.params);
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
    this.socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Inspector disconnected"));
      }
      this.pending.clear();
    });
    await new Promise((done, fail) => {
      this.socket.once("open", done);
      this.socket.once("error", fail);
      this.socket.once("unexpected-response", (_request, response) => {
        fail(new Error(`Inspector rejected connection: ${response.statusCode}`));
      });
    });
  }

  send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    const id = ++this.id;
    return new Promise((done, fail) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: done, reject: fail, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

function summarizeAllocation(profile) {
  const frames = new Map();
  function visit(node, parents) {
    const frame = node.callFrame;
    const name = `${frame.functionName || "(anonymous)"} ${frame.url || ""}:${frame.lineNumber + 1}`;
    const stack = [...parents, name];
    frames.set(node.id, stack);
    for (const child of node.children ?? []) {
      visit(child, stack);
    }
  }
  visit(profile.head, []);
  let sampledAllocationBytes = 0;
  const stacks = new Map();
  for (const sample of profile.samples ?? []) {
    sampledAllocationBytes += sample.size;
    const stack = (frames.get(sample.nodeId) ?? ["unknown"]).join(" > ");
    stacks.set(stack, (stacks.get(stack) ?? 0) + sample.size);
  }
  return {
    sampledAllocationBytes,
    topStacks: [...stacks]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([stack, bytes]) => ({ stack, bytes })),
  };
}

async function main() {
  const { mode, output, postMs, markerTimeoutMs, command } = parseArguments(process.argv.slice(2));
  await mkdir(dirname(output), { recursive: true });
  const inspectorUrl = new URL(process.env.WORKERD_CDP_URL ?? "http://localhost:9229");
  const response = await fetch(new URL("/json/list", inspectorUrl));
  if (!response.ok) {
    throw new Error(`Inspector discovery: ${response.status}`);
  }
  const targets = await response.json();
  const target = targets.find(
    (candidate) => new URL(candidate.webSocketDebuggerUrl).pathname.slice(1) === "rejot-backoffice",
  );
  if (!target) {
    throw new Error("Missing rejot-backoffice inspector target (use a preview build)");
  }

  const client = new InspectorClient(target.webSocketDebuggerUrl);
  await client.connect();
  let child;
  let polling = true;
  let pollPromise;
  const startedAt = Date.now();
  const samples = [];
  const markers = [];
  const allocations = {};
  let currentPhase = "streaming";
  let stepKey = null;
  let instanceRef = null;
  let phaseQueue = Promise.resolve();
  let markerQueue = Promise.resolve();
  let finished;
  let phaseFailed;
  const phaseFinished = new Promise((done, fail) => {
    finished = done;
    phaseFailed = fail;
  });

  async function startSampling() {
    if (mode === "sampled") {
      await client.send("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
  }

  async function endSampling(phase) {
    if (mode !== "sampled") {
      return;
    }
    const { profile } = await client.send("HeapProfiler.stopSampling");
    allocations[phase] = summarizeAllocation(profile);
    await writeFile(`${output}.${phase}.allocation.json`, `${JSON.stringify(profile)}\n`);
  }

  async function recordPhaseMarker(params) {
    const event = params.args?.[0]?.value;
    const remoteFields = params.args?.[1];
    let fields =
      remoteFields?.value ??
      Object.fromEntries(
        (remoteFields?.preview?.properties ?? []).map((property) => [
          property.name,
          property.value,
        ]),
      );
    if (typeof fields.stepKey !== "string" && remoteFields?.objectId) {
      const { result } = await client.send("Runtime.getProperties", {
        objectId: remoteFields.objectId,
        ownProperties: true,
      });
      fields = Object.fromEntries(result.map((property) => [property.name, property.value?.value]));
    }
    const field = (name) => fields[name];
    const markerKey = field("stepKey");
    if (typeof markerKey !== "string") {
      phaseFailed(new Error(`Missing stepKey in inspector marker: ${event}`));
      return;
    }
    if (event === STREAMING_COMPLETED) {
      if (field("workflowName") !== PI_WORKFLOW_NAME) {
        return;
      }
    }
    if (event === STREAMING_COMPLETED && stepKey === null) {
      const instanceId = field("instanceId");
      if (typeof instanceId !== "string") {
        phaseFailed(new Error("Missing instanceId in streaming-completed inspector marker"));
        return;
      }
      stepKey = markerKey;
      instanceRef = `wfi_${createHash("sha256").update(PI_WORKFLOW_NAME).update("\0").update(instanceId).digest("base64url")}`;
    }
    if (
      markerKey !== stepKey ||
      (event !== STREAMING_COMPLETED && field("instanceRef") !== instanceRef)
    ) {
      return;
    }
    // Inspector delivery can lag the console call; trace correlation needs the event's own time.
    if (!Number.isFinite(params.timestamp)) {
      phaseFailed(new Error(`Missing console timestamp in inspector marker: ${event}`));
      return;
    }
    markers.push({
      event,
      stepKey: markerKey,
      elapsedMs: Date.now() - startedAt,
      consoleEpochMs: params.timestamp,
    });
    if (event === CLEANUP_STARTED && currentPhase === "streaming") {
      currentPhase = "cleanup";
      phaseQueue = phaseQueue
        .then(async () => {
          await endSampling("streaming");
          await startSampling();
        })
        .catch(phaseFailed);
    } else if (event === CLEANUP_COMPLETED && currentPhase === "cleanup") {
      currentPhase = "post-cleanup";
      phaseQueue = phaseQueue
        .then(async () => {
          await endSampling("cleanup");
          await startSampling();
          finished();
        })
        .catch(phaseFailed);
    }
  }

  try {
    await client.send("Runtime.enable");
    await client.send("HeapProfiler.enable");
    await client.send("Runtime.discardConsoleEntries");
    await client.send("HeapProfiler.collectGarbage");
    const baseline = await client.send("Runtime.getHeapUsage");
    client.onConsole = (params) => {
      const event = params.args?.[0]?.value;
      if (
        event === STREAMING_COMPLETED ||
        event === CLEANUP_STARTED ||
        event === CLEANUP_COMPLETED
      ) {
        markerQueue = markerQueue.then(() => recordPhaseMarker(params)).catch(phaseFailed);
      }
    };
    await startSampling();

    pollPromise = (async () => {
      while (polling) {
        const phase = currentPhase;
        const usage = await client.send("Runtime.getHeapUsage");
        samples.push({ elapsedMs: Date.now() - startedAt, phase, ...usage });
        await new Promise((done) => {
          setTimeout(done, SAMPLE_INTERVAL_MS);
        });
      }
    })();
    void pollPromise.catch(phaseFailed);

    child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(createWriteStream(`${output}.stdout`));
    child.stderr.pipe(createWriteStream(`${output}.stderr`));
    const commandExit = new Promise((done, fail) => {
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        done({ code, signal });
      });
    });
    void commandExit.then((exit) => {
      if (exit.code !== 0) {
        phaseFailed(new Error(`Turn command exited with code ${exit.code}; see ${output}.stderr`));
      }
    }, phaseFailed);

    let markerTimeout;
    try {
      await Promise.race([
        phaseFinished,
        new Promise((_done, fail) => {
          markerTimeout = setTimeout(() => {
            fail(new Error(`Cleanup markers not observed within ${markerTimeoutMs}ms`));
          }, markerTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(markerTimeout);
    }
    await phaseQueue;
    await new Promise((done) => {
      setTimeout(done, postMs);
    });
    await endSampling("post-cleanup");
    const exit = await commandExit;
    polling = false;
    await pollPromise;
    const byPhase = Object.fromEntries(
      ["streaming", "cleanup", "post-cleanup"].map((phase) => {
        const phaseSamples = samples.filter((sample) => sample.phase === phase);
        return [
          phase,
          {
            peakUsedBytes: Math.max(0, ...phaseSamples.map((sample) => sample.usedSize)),
            sampleCount: phaseSamples.length,
            allocation: allocations[phase] ?? null,
          },
        ];
      }),
    );
    const result = {
      mode,
      command,
      startedAtEpochMs: startedAt,
      markerTimeoutMs,
      baseline,
      peakUsedBytes: Math.max(baseline.usedSize, ...samples.map((sample) => sample.usedSize)),
      markers,
      byPhase,
      exit,
    };
    await writeFile(`${output}.summary.json`, `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(
      `${output}.memory.tsv`,
      `elapsed_ms\tphase\tused_size\ttotal_size\n${samples.map((s) => `${s.elapsedMs}\t${s.phase}\t${s.usedSize}\t${s.totalSize}`).join("\n")}\n`,
    );
    console.log(`${output}.summary.json`);
    if (exit.code !== 0) {
      throw new Error(`Turn command exited with code ${exit.code}; summary and stderr were saved`);
    }
  } finally {
    polling = false;
    if (child?.exitCode === null) {
      child.kill();
    }
    await pollPromise?.catch(() => {});
    client.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
