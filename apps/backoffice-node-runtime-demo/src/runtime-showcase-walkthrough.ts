import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const serverModule = new URL("./runtime-showcase-server.js", import.meta.url);

async function runRuntimeShowcaseWalkthrough(): Promise<void> {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "backoffice-node-runtime-demo-"));
  let server: RuntimeShowcaseServerProcess | null = null;

  try {
    console.log("\n1. Start an authority-bound runtime with an empty filesystem Graft remote.");
    server = await RuntimeShowcaseServerProcess.start(dataDirectory);
    await showGetJson("health", server.origin, "/health");

    console.log("\n2. Group multiple SQL mutations behind one external output gate.");
    await showPostJson("output gate", server.origin, "/objects/demo/increments", {
      deltas: [2, 3],
      label: "http-output-gate",
    });

    console.log("\n3. Gate output on two independently durable object logs and worker threads.");
    const multiObject = await requestJsonWithOptions(server.origin, "/multi-object-increments", {
      method: "POST",
      body: {
        increments: [
          { name: "demo", delta: 1 },
          { name: "secondary", delta: 7 },
        ],
      },
    });
    assertDistinctObjectWorkers(multiObject);
    printJson("multi-object output gate", multiObject);

    console.log("\n4. Persist KV compatibility state beside application SQL.");
    await showPostJson("KV", server.origin, "/objects/demo/compatibility-value", {
      value: "durable KV from the standalone app",
    });

    console.log("\n5. Use a returned Cap'n Web capability with promise pipelining.");
    await showPostJson("capability", server.origin, "/objects/demo/capability", {
      deltas: [4, 1],
    });

    console.log("\n6. Round-trip a callback and structured RPC values across the worker boundary.");
    await showPostJson("callback", server.origin, "/objects/demo/callback", {});
    await showPostJson("values", server.origin, "/objects/demo/values", {});

    console.log("\n7. Proxy Request/Response objects, including a streamed response body.");
    await showPostJson("fetch mutation", server.origin, "/objects/demo/fetch/increment", {
      delta: 2,
      label: "request-response-rpc",
    });
    const stream = await requestText(server.origin, "/objects/demo/fetch/stream");
    console.log(`stream: ${stream}`);

    console.log("\n8. Drain registered waitUntil work and deliver a durable alarm.");
    await showPostJson("background", server.origin, "/objects/demo/background", {
      note: "waitUntil completed durably",
    });
    await showPostJson("schedule alarm", server.origin, "/objects/demo/alarm", { delayMs: 0 });
    await showPostJson("alarm tick", server.origin, "/tick", {});

    const beforeRestart = await requestJson(server.origin, "/objects/demo");
    assertSnapshot(beforeRestart, 14, "durable KV from the standalone app");
    printJson("state before restart", beforeRestart);
    const firstOwnership = await requestJson(server.origin, "/control/demo");
    assertOwnershipEpoch(firstOwnership, "1");
    printJson("control ownership", firstOwnership);

    console.log(
      "\n9. Stop cleanly, delete the entire process-local cache, and start a fresh process.",
    );
    await server.stop();
    server = null;
    await rm(path.join(dataDirectory, "cache"), { recursive: true, force: true });

    server = await RuntimeShowcaseServerProcess.start(dataDirectory);
    const restored = await requestJson(server.origin, "/objects/demo");
    assertSnapshot(restored, 14, "durable KV from the standalone app");
    printJson("restored primary state", restored);
    const restoredSecondary = await requestJson(server.origin, "/objects/secondary");
    assertSnapshot(restoredSecondary, 7, null);
    printJson("restored secondary state", restoredSecondary);
    const replacementOwnership = await requestJson(server.origin, "/control/demo");
    assertOwnershipEpoch(replacementOwnership, "2");
    printJson("replacement ownership", replacementOwnership);

    console.log(
      "\nShowcase complete: remote state survived cache deletion and was fenced at epoch 2.",
    );
  } finally {
    await server?.stop();
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

class RuntimeShowcaseServerProcess {
  readonly origin: string;

  readonly #child: ChildProcessWithoutNullStreams;
  #stopped = false;

  private constructor(child: ChildProcessWithoutNullStreams, origin: string) {
    this.#child = child;
    this.origin = origin;
  }

  static async start(dataDirectory: string): Promise<RuntimeShowcaseServerProcess> {
    const child = spawn(process.execPath, [serverModule.pathname], {
      cwd: path.dirname(serverModule.pathname),
      env: {
        ...process.env,
        BACKOFFICE_NODE_RUNTIME_DEMO_DATA_DIR: dataDirectory,
        BACKOFFICE_NODE_RUNTIME_DEMO_PORT: "0",
        BACKOFFICE_NODE_RUNTIME_DEMO_ALARM_INTERVAL_MS: "60000",
        BACKOFFICE_NODE_RUNTIME_DEMO_LEASE_DURATION_MS: "600000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const ready = Promise.withResolvers<string>();
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("RUNTIME_SHOWCASE_SERVER_READY:")) {
          const payload = JSON.parse(
            line.slice("RUNTIME_SHOWCASE_SERVER_READY:".length),
          ) as unknown;
          ready.resolve(requireString(requireRecord(payload, "ready payload"), "origin"));
        } else if (line.length > 0) {
          console.log(`[server] ${line}`);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(`[server] ${chunk.toString()}`);
    });
    child.once("exit", (code) => {
      ready.reject(
        new Error(`RUNTIME_SHOWCASE_SERVER_EXITED_BEFORE_READY:${String(code)}:${stderr}`),
      );
    });
    return new RuntimeShowcaseServerProcess(child, await ready.promise);
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    const exited = new Promise<number | null>((resolve) => {
      this.#child.once("exit", resolve);
    });
    this.#child.kill("SIGTERM");
    const exitCode = await exited;
    if (exitCode !== 0) {
      throw new Error(`RUNTIME_SHOWCASE_SERVER_STOP_FAILED:${String(exitCode)}`);
    }
  }
}

type RuntimeShowcaseRequestOptions = {
  method: string;
  body: Record<string, unknown> | null;
};

async function showGetJson(label: string, origin: string, pathname: string): Promise<void> {
  printJson(label, await requestJson(origin, pathname));
}

async function showPostJson(
  label: string,
  origin: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<void> {
  printJson(label, await requestJsonWithOptions(origin, pathname, { method: "POST", body }));
}

async function requestJson(origin: string, pathname: string): Promise<unknown> {
  return await requestJsonWithOptions(origin, pathname, { method: "GET", body: null });
}

async function requestJsonWithOptions(
  origin: string,
  pathname: string,
  options: RuntimeShowcaseRequestOptions,
): Promise<unknown> {
  const requestOptions: RequestInit = options.body
    ? {
        method: options.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options.body),
      }
    : { method: options.method };
  const response = await fetch(new URL(pathname, origin), requestOptions);
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(
      `RUNTIME_SHOWCASE_HTTP_REQUEST_FAILED:${response.status}:${JSON.stringify(value)}`,
    );
  }
  return value;
}

async function requestText(origin: string, pathname: string): Promise<string> {
  const response = await fetch(new URL(pathname, origin));
  const value = await response.text();
  if (!response.ok) {
    throw new Error(`RUNTIME_SHOWCASE_HTTP_REQUEST_FAILED:${response.status}:${value}`);
  }
  return value;
}

function assertSnapshot(value: unknown, count: number, compatibilityValue: string | null): void {
  const snapshot = requireRecord(value, "snapshot");
  if (snapshot["count"] !== count || snapshot["compatibilityValue"] !== compatibilityValue) {
    throw new Error(`RUNTIME_SHOWCASE_SNAPSHOT_UNEXPECTED:${JSON.stringify(value)}`);
  }
  const worker = requireRecord(snapshot["worker"], "snapshot worker");
  if (worker["isMainThread"] !== false) {
    throw new Error("RUNTIME_SHOWCASE_OBJECT_DID_NOT_RUN_IN_WORKER");
  }
}

function assertDistinctObjectWorkers(value: unknown): void {
  const response = requireRecord(value, "multi-object response");
  const snapshots = response["snapshots"];
  if (!Array.isArray(snapshots) || snapshots.length !== 2) {
    throw new Error(`RUNTIME_SHOWCASE_MULTI_OBJECT_RESULT_INVALID:${JSON.stringify(value)}`);
  }
  const firstWorker = requireRecord(
    requireRecord(snapshots[0], "first snapshot")["worker"],
    "first worker",
  );
  const secondWorker = requireRecord(
    requireRecord(snapshots[1], "second snapshot")["worker"],
    "second worker",
  );
  if (firstWorker["threadId"] === secondWorker["threadId"]) {
    throw new Error("RUNTIME_SHOWCASE_OBJECT_WORKERS_NOT_DISTINCT");
  }
}

function assertOwnershipEpoch(value: unknown, epoch: string): void {
  const response = requireRecord(value, "ownership response");
  const ownership = requireRecord(response["ownership"], "ownership");
  if (ownership["state"] !== "ready" || ownership["epoch"] !== epoch) {
    throw new Error(`RUNTIME_SHOWCASE_OWNERSHIP_UNEXPECTED:${JSON.stringify(value)}`);
  }
}

function printJson(label: string, value: unknown): void {
  console.log(`${label}: ${JSON.stringify(value, null, 2)}`);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`RUNTIME_SHOWCASE_RECORD_INVALID:${name}`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`RUNTIME_SHOWCASE_STRING_INVALID:${key}`);
  }
  return value;
}

await runRuntimeShowcaseWalkthrough();
