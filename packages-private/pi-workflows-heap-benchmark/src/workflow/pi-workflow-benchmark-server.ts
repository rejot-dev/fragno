import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import { createPiHarness, createPiWorkflows } from "@fragno-dev/pi-harness/factory";
import { createInteractiveChatWorkflow } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { migrate } from "@fragno-dev/db";
import { toNodeHandler } from "@fragno-dev/node";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import { createModels, type Provider } from "@earendil-works/pi-ai";

import {
  closeBenchmarkChild,
  forkBenchmarkClient,
  sendBenchmarkChildMessage,
  waitForBenchmarkChildMessage,
} from "../benchmark-runtime/benchmark-child-process";
import type { PiWorkflowBenchmarkMetrics } from "../benchmark-runtime/server-benchmark-metrics";
import {
  forceServerGarbageCollection,
  measureRetainedServerMemory,
  startServerMemoryMeasurement,
} from "../benchmark-runtime/server-memory-measurement";
import {
  parsePiWorkflowBenchmarkArguments,
  type PiWorkflowLiveProvider,
} from "./pi-workflow-benchmark-config";
import {
  parsePiWorkflowBenchmarkClientMessage,
  type PiWorkflowBenchmarkClientConfig,
  type PiWorkflowBenchmarkClientResult,
} from "./pi-workflow-benchmark-protocol";
import {
  createAssistantTraceCaptureProvider,
  createRecordedAssistantProvider,
  parseRecordedAssistantTrace,
} from "./recorded-assistant-provider";

const PI_MOUNT_ROUTE = "/api/pi-harness";
const WORKFLOWS_MOUNT_ROUTE = "/api/workflows";
const WORKFLOW_NAME = "poem-chat";
const PROMPT =
  "Write a long original poem of at least 80 stanzas, each with four lines. Use vivid imagery and a continuing narrative. Do not summarize, skip stanzas, or stop early.";
const POLL_INTERVAL_MS = 300;
const COMMAND_WAIT_TIMEOUT_MS = 900_000;
const MEMORY_SAMPLE_INTERVAL_MS = 10;
const ALLOCATION_SAMPLE_INTERVAL_BYTES = 512 * 1_024;
const recordedTracePath = fileURLToPath(
  new URL("../../fixtures/poem-assistant-stream.json", import.meta.url),
);
const liveProviderFactories = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
} as const satisfies Record<PiWorkflowLiveProvider, () => Provider>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requestTargetsMountRoute(request: Request, mountRoute: string): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === mountRoute || pathname.startsWith(`${mountRoute}/`);
}

async function startPiWorkflowBenchmarkServer(
  pi: ReturnType<typeof createPiHarness>,
  workflows: ReturnType<typeof createWorkflowsFragment>,
): Promise<{
  server: Server;
  piBaseUrl: string;
  workflowsBaseUrl: string;
}> {
  const server = createServer(
    toNodeHandler(async (request) => {
      if (requestTargetsMountRoute(request, pi.mountRoute)) {
        return pi.handler(request);
      }
      if (requestTargetsMountRoute(request, workflows.mountRoute)) {
        return workflows.handler(request);
      }
      return new Response("Not Found", { status: 404 });
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Pi workflow benchmark server did not receive a TCP port.");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    piBaseUrl: `${origin}${pi.mountRoute}`,
    workflowsBaseUrl: `${origin}${workflows.mountRoute}`,
  };
}

async function closePiWorkflowBenchmarkServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function spawnPiWorkflowBenchmarkClient(): Promise<ChildProcess> {
  const client = forkBenchmarkClient(
    fileURLToPath(new URL("./pi-workflow-benchmark-client.ts", import.meta.url)),
  );
  try {
    const ready = await waitForBenchmarkChildMessage(
      client,
      parsePiWorkflowBenchmarkClientMessage,
      "Pi workflow benchmark",
    );
    if (ready.type !== "ready") {
      throw new Error(
        ready.type === "failed"
          ? `Pi workflow benchmark client failed during startup: ${ready.error}`
          : "Pi workflow benchmark client replied before startup completed.",
      );
    }
    return client;
  } catch (error) {
    client.kill();
    throw error;
  }
}

async function preparePiWorkflowBenchmarkClient(
  client: ChildProcess,
  config: PiWorkflowBenchmarkClientConfig,
): Promise<void> {
  const response = waitForBenchmarkChildMessage(
    client,
    parsePiWorkflowBenchmarkClientMessage,
    "Pi workflow benchmark",
  );
  await sendBenchmarkChildMessage(client, { type: "prepare", config });
  const message = await response;
  if (message.type === "failed") {
    throw new Error(`Pi workflow benchmark client failed during preparation: ${message.error}`);
  }
  if (message.type !== "prepared") {
    throw new Error("Pi workflow benchmark client did not confirm preparation.");
  }
}

async function runPiWorkflowBenchmarkClient(
  client: ChildProcess,
): Promise<PiWorkflowBenchmarkClientResult> {
  const response = waitForBenchmarkChildMessage(
    client,
    parsePiWorkflowBenchmarkClientMessage,
    "Pi workflow benchmark",
  );
  await sendBenchmarkChildMessage(client, { type: "start" });
  const message = await response;
  if (message.type === "failed") {
    throw new Error(`Pi workflow benchmark client failed: ${message.error}`);
  }
  if (message.type !== "complete") {
    throw new Error("Pi workflow benchmark client did not return workload metrics.");
  }
  return message.result;
}

async function waitForWorkflowCommandState(
  workflows: ReturnType<typeof createWorkflowsFragment>,
  sessionId: string,
): Promise<void> {
  const readyBy = Date.now() + 30_000;
  while (
    (
      await workflows.callServices(() =>
        workflows.services.getInstanceStatus(WORKFLOW_NAME, sessionId),
      )
    ).status !== "waiting"
  ) {
    if (Date.now() > readyBy) {
      throw new Error("Pi workflow benchmark did not reach its command wait.");
    }
    await sleep(25);
  }
}

async function runPiWorkflowBenchmark(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: pnpm measure -- [--stream] [--profile] [--replay-speed FACTOR]\n       pnpm measure -- --capture [--provider openai|anthropic|google] [--model MODEL_ID]\nRuns the Pi workflow in a measured HTTP server process while an unmeasured child consumes outbox changes and command routes. Replays the recorded assistant trace at 4x speed by default. --capture makes one live model call and replaces the trace.",
    );
    return;
  }

  const config = parsePiWorkflowBenchmarkArguments(process.argv.slice(2), process.env);
  const directory = await mkdtemp(path.join(tmpdir(), "pi-workflow-benchmark-"));
  const sqlite = new Database(path.join(directory, "benchmark.sqlite"));
  const databaseAdapter = new SqlAdapter({
    dialect: new SqliteDialect({ database: sqlite }),
    driverConfig: new BetterSQLite3DriverConfig(),
  });
  let server: Server | null = null;
  let client: ChildProcess | null = null;
  let stopDispatcher: (() => void) | null = null;

  try {
    const models = createModels({
      authContext: {
        env: async (name) => process.env[name],
        fileExists: async () => false,
      },
    });
    let metricsProvider: string;
    let metricsModelId: string;
    let model;
    if (config.agent.kind === "capture") {
      const captureAgent = config.agent;
      const sourceProvider = liveProviderFactories[captureAgent.provider]();
      models.setProvider(
        createAssistantTraceCaptureProvider(sourceProvider, {
          prompt: PROMPT,
          writeTrace: async (trace) => {
            await mkdir(path.dirname(recordedTracePath), { recursive: true });
            await writeFile(recordedTracePath, `${JSON.stringify(trace, null, 2)}\n`);
            console.error(`Assistant trace written to ${recordedTracePath}`);
          },
        }),
      );
      model = models
        .getModels(captureAgent.provider)
        .find((candidate) => candidate.id === captureAgent.modelId);
      if (!model) {
        throw new Error(
          `Pi workflow benchmark model ${captureAgent.provider}/${captureAgent.modelId} is unavailable.`,
        );
      }
      metricsProvider = captureAgent.provider;
      metricsModelId = captureAgent.modelId;
    } else {
      const trace = parseRecordedAssistantTrace(
        JSON.parse(await readFile(recordedTracePath, "utf8")),
      );
      if (trace.prompt !== PROMPT) {
        throw new Error(
          "Recorded assistant trace does not match the Pi workflow benchmark prompt.",
        );
      }
      const recorded = createRecordedAssistantProvider(trace, config.agent.replaySpeed);
      models.setProvider(recorded.provider);
      model = recorded.model;
      metricsProvider = `recorded:${trace.sourceModel.provider}`;
      metricsModelId = `${trace.sourceModel.id}@${config.agent.replaySpeed}x`;
    }

    const workflow = createInteractiveChatWorkflow({
      name: WORKFLOW_NAME,
      options: {
        models,
        model,
        systemPrompt: "You are a poet. Complete the user's poem request in full.",
      },
    });
    const workflows = createWorkflowsFragment(
      { workflows: createPiWorkflows({ workflows: [workflow] }), runtime: defaultFragnoRuntime },
      {
        databaseAdapter,
        mountRoute: WORKFLOWS_MOUNT_ROUTE,
        outbox: { enabled: true },
      },
    );
    const pi = createPiHarness(
      { workflows: [workflow] },
      { databaseAdapter, mountRoute: PI_MOUNT_ROUTE, outbox: { enabled: true } },
      { workflows: workflows.services },
    );
    await migrate(workflows);
    await migrate(pi);

    const dispatcher = createDurableHooksProcessor([workflows, pi], {
      pollIntervalMs: 25,
      onError: (error) => {
        console.error("Pi workflow benchmark dispatcher error:", error);
      },
    });
    dispatcher.startPolling();
    stopDispatcher = () => {
      dispatcher.stopPolling();
    };

    const sessionId = crypto.randomUUID();
    await pi.callServices(() =>
      pi.services.createWorkflowSession({
        id: sessionId,
        workflowName: WORKFLOW_NAME,
        name: "Poem benchmark",
      }),
    );
    await waitForWorkflowCommandState(workflows, sessionId);

    const benchmarkServer = await startPiWorkflowBenchmarkServer(pi, workflows);
    server = benchmarkServer.server;
    client = await spawnPiWorkflowBenchmarkClient();
    await preparePiWorkflowBenchmarkClient(client, {
      mode: config.mode,
      piBaseUrl: benchmarkServer.piBaseUrl,
      workflowsBaseUrl: benchmarkServer.workflowsBaseUrl,
      workflowName: WORKFLOW_NAME,
      sessionId,
      prompt: PROMPT,
      pollIntervalMs: POLL_INTERVAL_MS,
      waitTimeoutMs: COMMAND_WAIT_TIMEOUT_MS,
    });
    await forceServerGarbageCollection();

    const profileFilePath = path.resolve(
      `pi-workflow-${config.mode}-${Date.now()}-${process.pid}.heapprofile`,
    );
    const measurement = startServerMemoryMeasurement({
      profile: config.profile,
      profileFilePath,
      allocationSampleIntervalBytes: ALLOCATION_SAMPLE_INTERVAL_BYTES,
      memorySampleIntervalMs: MEMORY_SAMPLE_INTERVAL_MS,
    });

    let result: PiWorkflowBenchmarkClientResult;
    let measured: Awaited<ReturnType<typeof measurement.finish>>;
    try {
      result = await runPiWorkflowBenchmarkClient(client);
      measured = await measurement.finish();
    } catch (error) {
      await measurement.abort();
      throw error;
    }

    await closeBenchmarkChild(client, { type: "close" });
    client = null;
    const memory = await measureRetainedServerMemory(measured);
    const metrics = {
      ...memory,
      kind: "pi-workflow",
      nodeVersion: process.version,
      outboxMode: config.mode,
      transport: "node-http",
      measurementScope: "server",
      provider: metricsProvider,
      modelId: metricsModelId,
      outboxEntriesRead: result.outboxEntriesRead,
      durationMs: measured.durationMs,
      status: result.status,
    } satisfies PiWorkflowBenchmarkMetrics;

    if (measured.profile.kind === "written") {
      await writeFile(
        measured.profile.filePath.replace(/\.heapprofile$/, ".benchmark-metrics.json"),
        `${JSON.stringify(metrics, null, 2)}\n`,
      );
    }
    console.log(
      JSON.stringify(
        { ...metrics, timeline: undefined, timelineSamples: metrics.timeline.length },
        null,
        2,
      ),
    );
  } finally {
    if (client) {
      await closeBenchmarkChild(client, { type: "close" }).catch(() => {
        client?.kill();
      });
    }
    if (server) {
      await closePiWorkflowBenchmarkServer(server).catch(() => {
        server?.closeAllConnections();
      });
    }
    stopDispatcher?.();
    await databaseAdapter.close();
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  }
}

await runPiWorkflowBenchmark();
