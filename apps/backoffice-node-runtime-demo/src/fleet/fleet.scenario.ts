import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fleetServerModule = new URL("../start-fleet.js", import.meta.url);

async function runFleetScenario(): Promise<void> {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "demo-main-fleet-"));
  let main: DemoFleetProcess | null = null;
  try {
    console.log("\nFleet UI 1. Start one fleet app supervising three runtime nodes.");
    main = await DemoFleetProcess.start(dataDirectory, 3);
    const initial = requireFleetSnapshot(await requestJson(main.origin, "/api/fleet"));
    const servingNodes = initial.nodes.filter((node) => node["state"] === "serving");
    if (servingNodes.length !== 3) {
      throw new Error("DEMO_FLEET_NODES_NOT_SERVING");
    }
    const nodeIds = new Set(
      servingNodes.map((node) => requireString(requireRecord(node["identity"]), "nodeId")),
    );
    if (nodeIds.size !== 3) {
      throw new Error("DEMO_FLEET_NODE_IDENTITIES_NOT_UNIQUE");
    }
    const html = await requestText(main.origin, "/");
    for (const marker of ["node-count", "placement", "multi-form", "request-form"]) {
      if (!html.includes(`id="${marker}"`)) {
        throw new Error(`DEMO_FLEET_PAGE_MARKER_MISSING:${marker}`);
      }
    }

    console.log("\nFleet UI 2. Provision demo through node-1, then reach it through node-2.");
    const internalApplication = await forwardNodeRequest(
      main.origin,
      "node-1",
      "GET",
      "/objects/demo",
      null,
      "internal",
    );
    assert.equal(internalApplication["status"], 404);
    const applicationInspection = await forwardNodeRequest(
      main.origin,
      "node-1",
      "GET",
      "/debug/overview",
      null,
    );
    assert.equal(applicationInspection["status"], 404);
    const internalInspection = await forwardNodeRequest(
      main.origin,
      "node-1",
      "GET",
      "/debug/overview",
      null,
      "internal",
    );
    assert.equal(internalInspection["status"], 200);
    await forwardNodeRequest(main.origin, "node-1", "GET", "/objects/demo", null);
    const demoOwner = requireManagedObjectOwner(
      requireFleetObject(await requestJson(main.origin, "/api/fleet"), "demo"),
    );
    if (demoOwner.slot !== "node-1") {
      throw new Error(`DEMO_FLEET_DEMO_OWNER_UNEXPECTED:${demoOwner.slot}`);
    }
    const remoteRead = await forwardNodeRequest(
      main.origin,
      "node-2",
      "GET",
      "/objects/demo",
      null,
    );
    const remoteSnapshot = requireRecord(
      requireRecord(remoteRead["body"])["value"],
      "remote object snapshot",
    );
    const objectWorker = requireRecord(remoteSnapshot["worker"], "remote object worker");
    const fleetSnapshot = await requestJson(main.origin, "/api/fleet");
    const ingressIdentity = requireRecord(
      requireFleetNode(fleetSnapshot, "node-2")["identity"],
      "node-2 identity",
    );
    if (remoteRead["nodeSlot"] !== "node-2" || remoteRead["nodeId"] !== ingressIdentity["nodeId"]) {
      throw new Error("DEMO_FLEET_INGRESS_IDENTITY_UNEXPECTED");
    }
    const nodeOne = requireFleetNode(fleetSnapshot, "node-1");
    if (
      objectWorker["processId"] !==
      requireRecord(nodeOne["identity"], "node-1 identity")["processId"]
    ) {
      throw new Error("DEMO_FLEET_REMOTE_ROUTE_DID_NOT_REACH_OWNER");
    }

    console.log("\nFleet UI 3. Send demo, secondary, and customer-42 through node-2.");
    await forwardNodeRequest(main.origin, "node-2", "POST", "/multi-object-increments", {
      increments: [
        { name: "demo", delta: 1 },
        { name: "secondary", delta: 7 },
        { name: "customer-42", delta: 11 },
      ],
    });
    const active = requireFleetSnapshot(await requestJson(main.origin, "/api/fleet"));
    for (const name of ["demo", "secondary", "customer-42"]) {
      const object = requireFleetObject(active, name);
      if (requireRecord(object["status"])["kind"] !== "active") {
        throw new Error(`DEMO_FLEET_OBJECT_NOT_ACTIVE:${name}`);
      }
      requireManagedObjectOwner(object);
    }

    console.log("\nFleet UI 4. Gracefully stop node-1 and take demo over through node-2.");
    await changeNodeLifecycle(main.origin, "node-1", "stop");
    await forwardNodeRequest(main.origin, "node-2", "GET", "/objects/demo", null);
    const afterGracefulStop = requireFleetSnapshot(await requestJson(main.origin, "/api/fleet"));
    const stoppedNode = requireFleetNode(afterGracefulStop, "node-1");
    if (stoppedNode["state"] !== "stopped") {
      throw new Error("DEMO_FLEET_NODE_NOT_STOPPED");
    }
    const takenOverDemo = requireFleetObject(afterGracefulStop, "demo");
    if (requireManagedObjectOwner(takenOverDemo).slot !== "node-2") {
      throw new Error("DEMO_FLEET_GRACEFUL_TAKEOVER_FAILED");
    }

    console.log("\nFleet UI 5. Hard-crash node-2, wait for expiry, and take over on node-3.");
    await changeNodeLifecycle(main.origin, "node-2", "crash");
    const afterCrash = requireFleetSnapshot(await requestJson(main.origin, "/api/fleet"));
    const crashedNode = requireFleetNode(afterCrash, "node-2");
    if (crashedNode["state"] !== "crashed") {
      throw new Error("DEMO_FLEET_NODE_NOT_CRASHED");
    }
    const crashedDemoStatus = requireRecord(
      requireFleetObject(afterCrash, "demo")["status"],
      "crashed demo status",
    );
    const leaseExpiresAtMs = requireNumber(crashedDemoStatus, "ownerLeaseExpiresAtMs");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, leaseExpiresAtMs - Date.now() + 200));
    });
    await forwardNodeRequest(main.origin, "node-3", "GET", "/objects/demo", null);
    const afterCrashTakeover = requireFleetSnapshot(await requestJson(main.origin, "/api/fleet"));
    if (
      requireManagedObjectOwner(requireFleetObject(afterCrashTakeover, "demo")).slot !== "node-3"
    ) {
      throw new Error("DEMO_FLEET_CRASH_TAKEOVER_FAILED");
    }

    console.log("\nFleet UI 6. Restart node-1 from an empty cache and preserve remote state.");
    await changeNodeLifecycle(main.origin, "node-1", "delete-cache-and-restart");
    await forwardNodeRequest(main.origin, "node-1", "GET", "/objects/demo", null);
    const restored = requireFleetSnapshot(await requestJson(main.origin, "/api/fleet"));
    if (requireFleetNode(restored, "node-1")["state"] !== "serving") {
      throw new Error("DEMO_FLEET_NODE_NOT_RESTARTED");
    }
    if (requireManagedObjectOwner(requireFleetObject(restored, "demo")).slot !== "node-3") {
      throw new Error("DEMO_FLEET_REMOTE_STATE_ROUTE_CHANGED");
    }

    console.log("\nFleet scenario complete.");
  } finally {
    await main?.stop();
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

class DemoFleetProcess {
  readonly origin: string;
  readonly #child: ChildProcessWithoutNullStreams;
  #stopped = false;

  private constructor(child: ChildProcessWithoutNullStreams, origin: string) {
    this.#child = child;
    this.origin = origin;
  }

  static async start(dataDirectory: string, nodeCount: number): Promise<DemoFleetProcess> {
    const child = spawn(
      process.execPath,
      [fleetServerModule.pathname, "--nodes", String(nodeCount)],
      {
        cwd: path.dirname(fleetServerModule.pathname),
        env: {
          ...process.env,
          BACKOFFICE_NODE_RUNTIME_DEMO_DATA_DIR: dataDirectory,
          BACKOFFICE_NODE_RUNTIME_DEMO_FLEET_PORT: "0",
          BACKOFFICE_NODE_RUNTIME_DEMO_ALARM_INTERVAL_MS: "60000",
          BACKOFFICE_NODE_RUNTIME_DEMO_LEASE_DURATION_MS: "3000",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const ready = Promise.withResolvers<string>();
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("DEMO_FLEET_READY:")) {
          const payload = requireRecord(
            JSON.parse(line.slice("DEMO_FLEET_READY:".length)) as unknown,
            "fleet ready payload",
          );
          ready.resolve(requireString(payload, "origin"));
        } else if (line.length > 0) {
          console.log(`[fleet-main] ${line}`);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(`[fleet-main] ${chunk.toString()}`);
    });
    child.once("exit", (code, signal) => {
      ready.reject(
        new Error(`DEMO_FLEET_EXITED_BEFORE_READY:${String(code)}:${String(signal)}:${stderr}`),
      );
    });
    return new DemoFleetProcess(child, await ready.promise);
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
      throw new Error(`DEMO_FLEET_STOP_FAILED:${String(exitCode)}`);
    }
  }
}

async function forwardNodeRequest(
  origin: string,
  nodeSlot: string,
  method: "GET" | "POST",
  pathname: string,
  body: unknown,
  ingress: "application" | "internal" = "application",
): Promise<Record<string, unknown>> {
  return requireRecord(
    await requestJsonWithOptions(origin, `/api/nodes/${nodeSlot}/requests`, {
      method: "POST",
      body: { ingress, method, path: pathname, body },
    }),
    "forwarded response",
  );
}

async function changeNodeLifecycle(
  origin: string,
  nodeSlot: string,
  action: string,
): Promise<void> {
  await requestJsonWithOptions(origin, `/api/nodes/${nodeSlot}/lifecycle`, {
    method: "POST",
    body: { action },
  });
}

async function requestJson(origin: string, pathname: string): Promise<unknown> {
  return await requestJsonWithOptions(origin, pathname, { method: "GET", body: null });
}

async function requestJsonWithOptions(
  origin: string,
  pathname: string,
  options: { method: string; body: unknown },
): Promise<unknown> {
  const response = await fetch(
    new URL(pathname, origin),
    options.body === null
      ? { method: options.method }
      : {
          method: options.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options.body),
        },
  );
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`DEMO_FLEET_HTTP_REQUEST_FAILED:${response.status}:${JSON.stringify(value)}`);
  }
  return value;
}

async function requestText(origin: string, pathname: string): Promise<string> {
  const response = await fetch(new URL(pathname, origin));
  const value = await response.text();
  if (!response.ok) {
    throw new Error(`DEMO_FLEET_HTTP_REQUEST_FAILED:${response.status}:${value}`);
  }
  return value;
}

function requireFleetSnapshot(value: unknown): {
  nodes: Record<string, unknown>[];
  objects: Record<string, unknown>[];
} {
  const snapshot = requireRecord(value, "fleet snapshot");
  if (!Array.isArray(snapshot["nodes"]) || !Array.isArray(snapshot["objects"])) {
    throw new Error("DEMO_FLEET_SNAPSHOT_INVALID");
  }
  return {
    nodes: snapshot["nodes"].map((node) => requireRecord(node, "fleet node")),
    objects: snapshot["objects"].map((object) => requireRecord(object, "fleet object")),
  };
}

function requireFleetNode(value: unknown, slot: string): Record<string, unknown> {
  const node = requireFleetSnapshot(value).nodes.find((candidate) => candidate["slot"] === slot);
  if (!node) {
    throw new Error(`DEMO_FLEET_NODE_MISSING:${slot}`);
  }
  return node;
}

function requireFleetObject(value: unknown, name: string): Record<string, unknown> {
  const object = requireFleetSnapshot(value).objects.find(
    (candidate) => candidate["name"] === name,
  );
  if (!object) {
    throw new Error(`DEMO_FLEET_OBJECT_MISSING:${name}`);
  }
  return object;
}

function requireManagedObjectOwner(object: Record<string, unknown>): {
  slot: string;
  nodeId: string;
} {
  const owner = requireRecord(object["owner"], "object owner");
  if (owner["kind"] !== "managed") {
    throw new Error(`DEMO_FLEET_OWNER_NOT_MANAGED:${JSON.stringify(owner)}`);
  }
  return { slot: requireString(owner, "slot"), nodeId: requireString(owner, "nodeId") };
}

function requireRecord(value: unknown, name = "record"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`DEMO_RECORD_INVALID:${name}`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`DEMO_STRING_INVALID:${key}`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`DEMO_NUMBER_INVALID:${key}`);
  }
  return value;
}

await runFleetScenario();
