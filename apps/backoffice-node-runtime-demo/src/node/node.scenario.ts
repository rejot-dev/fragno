import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { provisionFilesystemGraftStorage } from "../fleet/local-filesystem-graft-storage";
import { DemoNodeProcess } from "../fleet/node-process";
const peerAuthenticationSecret = "demo-scenario-peer-authentication-secret";

async function runNodeScenario(): Promise<void> {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "backoffice-node-runtime-demo-"));
  let nodeA: DemoNodeProcess | null = null;
  let nodeB: DemoNodeProcess | null = null;
  let nodeC: DemoNodeProcess | null = null;

  try {
    console.log("\n1. Provision one shared control log; object logs start absent.");
    printJson("fleet", await provisionFilesystemGraftStorage(dataDirectory));

    console.log("\n2. Start two serving nodes with independent disposable caches.");
    nodeA = await startScenarioNode(dataDirectory, "node-a");
    nodeB = await startScenarioNode(dataDirectory, "node-b");
    const healthA = await requestJson(nodeA.internalOrigin, "/health");
    const healthB = await requestJson(nodeB.internalOrigin, "/health");
    printJson("node A health", healthA);
    printJson("node B health", healthB);
    const initialOverview = await requestText(nodeA.internalOrigin, "/");
    assertNodeOverviewObject(initialOverview, "SHOWCASE:demo", "not-provisioned", null);
    assertNodeOverviewObject(initialOverview, "SHOWCASE:secondary", "not-provisioned", null);
    const initialLeaseExpiryMs = requireNumber(
      requireRecord(
        requireRecord(requireRecord(healthA, "node A health")["nodeAuthority"], "node authority")[
          "window"
        ],
        "authority window",
      ),
      "leaseExpiresAtEpochMs",
    );

    console.log("\n3. Lazily provision demo on node A and secondary on node B.");
    await showPostJson("demo output gate", nodeA.applicationOrigin, "/objects/demo/increments", {
      deltas: [2, 3],
      label: "http-output-gate",
    });
    assertSnapshot(await requestJson(nodeB.applicationOrigin, "/objects/secondary"), 0, null);
    assertOwnedBy(await requestJson(nodeA.internalOrigin, "/control/demo"), nodeA.nodeId, "1");
    assertOwnedBy(await requestJson(nodeB.internalOrigin, "/control/secondary"), nodeB.nodeId, "1");
    const activeOverview = await requestText(nodeA.internalOrigin, "/");
    assertNodeOverviewObject(activeOverview, "SHOWCASE:demo", "active", nodeA.nodeId);
    assertNodeOverviewObject(activeOverview, "SHOWCASE:secondary", "active", nodeB.nodeId);

    console.log("\n4. Route one external output boundary across both object owners.");
    const multiObject = await requestJsonWithOptions(
      nodeA.applicationOrigin,
      "/multi-object-increments",
      {
        method: "POST",
        body: {
          increments: [
            { name: "demo", delta: 1 },
            { name: "secondary", delta: 7 },
          ],
        },
      },
    );
    assertDistinctObjectProcesses(multiObject);
    printJson("multi-object output gate", multiObject);

    console.log("\n5. Reach demo through node B over authenticated peer Cap'n Web.");
    await showPostJson(
      "KV through peer",
      nodeB.applicationOrigin,
      "/objects/demo/compatibility-value",
      {
        value: "durable KV from the standalone app",
      },
    );
    await showPostJson(
      "callback through peer",
      nodeB.applicationOrigin,
      "/objects/demo/callback",
      {},
    );
    await showPostJson(
      "capability through peer",
      nodeB.applicationOrigin,
      "/objects/demo/capability",
      {
        deltas: [4, 1],
      },
    );
    await showPostJson("values through peer", nodeB.applicationOrigin, "/objects/demo/values", {});
    await showPostJson(
      "fetch mutation through peer",
      nodeB.applicationOrigin,
      "/objects/demo/fetch/increment",
      {
        delta: 2,
        label: "request-response-rpc",
      },
    );
    console.log(
      `peer stream: ${await requestText(nodeB.applicationOrigin, "/objects/demo/fetch/stream")}`,
    );

    console.log("\n6. Deliver owner-local waitUntil work and an alarm.");
    await showPostJson("background", nodeA.applicationOrigin, "/objects/demo/background", {
      note: "waitUntil completed durably",
    });
    await showPostJson("schedule alarm", nodeB.applicationOrigin, "/objects/demo/alarm", {
      delayMs: 0,
    });
    await showPostJson("owner alarm tick", nodeA.internalOrigin, "/tick", {});
    assertSnapshot(
      await requestJson(nodeB.applicationOrigin, "/objects/demo"),
      14,
      "durable KV from the standalone app",
    );
    assertSnapshot(await requestJson(nodeA.applicationOrigin, "/objects/secondary"), 7, null);

    console.log("\n7. Verify node A renews beyond its original authority window.");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, initialLeaseExpiryMs - Date.now() + 100));
    });
    const renewedAuthority = requireRecord(
      requireRecord(await requestJson(nodeA.internalOrigin, "/health"), "renewed health")[
        "nodeAuthority"
      ],
      "renewed authority",
    );
    const renewedWindow = requireRecord(renewedAuthority["window"], "renewed window");
    if (
      renewedAuthority["state"] !== "serving" ||
      requireNumber(renewedWindow, "leaseExpiresAtEpochMs") <= initialLeaseExpiryMs
    ) {
      throw new Error("DEMO_LEASE_NOT_RENEWED");
    }
    printJson("renewed authority", renewedAuthority);

    console.log("\n8. Hard-kill node A, then let node B take over demo after lease expiry.");
    const finalHealthA = requireRecord(
      await requestJson(nodeA.internalOrigin, "/health"),
      "final health A",
    );
    const finalAuthorityA = requireRecord(finalHealthA["nodeAuthority"], "final authority A");
    const finalWindowA = requireRecord(finalAuthorityA["window"], "final window A");
    const finalLeaseExpiryMs = requireNumber(finalWindowA, "leaseExpiresAtEpochMs");
    await nodeA.crash();
    nodeA = null;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, finalLeaseExpiryMs - Date.now() + 200));
    });
    const takenOver = await requestJson(nodeB.applicationOrigin, "/objects/demo");
    assertSnapshot(takenOver, 14, "durable KV from the standalone app");
    assertOwnedBy(await requestJson(nodeB.internalOrigin, "/control/demo"), nodeB.nodeId, "2");
    assertNodeOverviewObject(
      await requestText(nodeB.internalOrigin, "/"),
      "SHOWCASE:demo",
      "active",
      nodeB.nodeId,
    );
    printJson("taken-over demo", takenOver);

    console.log("\n9. Stop node B, delete every node cache, and recover in node C.");
    await nodeB.stop(10_000);
    nodeB = null;
    await rm(path.join(dataDirectory, "cache"), { recursive: true, force: true });
    nodeC = await startScenarioNode(dataDirectory, "node-c");
    const restoredDemo = await requestJson(nodeC.applicationOrigin, "/objects/demo");
    const restoredSecondary = await requestJson(nodeC.applicationOrigin, "/objects/secondary");
    assertSnapshot(restoredDemo, 14, "durable KV from the standalone app");
    assertSnapshot(restoredSecondary, 7, null);
    assertOwnedBy(await requestJson(nodeC.internalOrigin, "/control/demo"), nodeC.nodeId, "3");
    assertOwnedBy(await requestJson(nodeC.internalOrigin, "/control/secondary"), nodeC.nodeId, "2");
    printJson("restored demo", restoredDemo);
    printJson("restored secondary", restoredSecondary);

    console.log(
      "\nNode scenario complete: either ingress reached the live owner, takeover fenced the old owner, and fresh caches restored remote state.",
    );
  } finally {
    await nodeA?.stop(10_000);
    await nodeB?.stop(10_000);
    await nodeC?.stop(10_000);
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function startScenarioNode(dataDirectory: string, slot: string): Promise<DemoNodeProcess> {
  return await DemoNodeProcess.start({
    environment: process.env,
    slot,
    dataDirectory,
    cacheDirectory: path.join(dataDirectory, "cache", slot),
    peerAuthenticationSecret,
    alarmIntervalMs: 60_000,
    leaseDurationMs: 5_000,
  });
}

type NodeScenarioRequestOptions = {
  method: string;
  body: Record<string, unknown> | null;
};

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
  options: NodeScenarioRequestOptions,
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
    throw new Error(`DEMO_HTTP_REQUEST_FAILED:${response.status}:${JSON.stringify(value)}`);
  }
  return value;
}

async function requestText(origin: string, pathname: string): Promise<string> {
  const response = await fetch(new URL(pathname, origin));
  const value = await response.text();
  if (!response.ok) {
    throw new Error(`DEMO_HTTP_REQUEST_FAILED:${response.status}:${value}`);
  }
  return value;
}

function assertSnapshot(value: unknown, count: number, compatibilityValue: string | null): void {
  const snapshot = requireRecord(value, "snapshot");
  if (snapshot["count"] !== count || snapshot["compatibilityValue"] !== compatibilityValue) {
    throw new Error(`DEMO_SNAPSHOT_UNEXPECTED:${JSON.stringify(value)}`);
  }
  const worker = requireRecord(snapshot["worker"], "snapshot worker");
  if (worker["isMainThread"] !== false) {
    throw new Error("DEMO_OBJECT_DID_NOT_RUN_IN_WORKER");
  }
}

function assertDistinctObjectProcesses(value: unknown): void {
  const response = requireRecord(value, "multi-object response");
  const snapshots = response["snapshots"];
  if (!Array.isArray(snapshots) || snapshots.length !== 2) {
    throw new Error(`DEMO_MULTI_OBJECT_RESULT_INVALID:${JSON.stringify(value)}`);
  }
  const firstWorker = requireRecord(
    requireRecord(snapshots[0], "first snapshot")["worker"],
    "first worker",
  );
  const secondWorker = requireRecord(
    requireRecord(snapshots[1], "second snapshot")["worker"],
    "second worker",
  );
  if (firstWorker["processId"] === secondWorker["processId"]) {
    throw new Error("DEMO_OBJECT_PROCESSES_NOT_DISTINCT");
  }
}

function assertOwnedBy(value: unknown, nodeId: string, epoch: string): void {
  const response = requireRecord(value, "ownership response");
  const ownership = requireRecord(response["ownership"], "ownership");
  if (
    ownership["state"] !== "ready" ||
    ownership["ownerNodeId"] !== nodeId ||
    ownership["epoch"] !== epoch
  ) {
    throw new Error(`DEMO_OWNERSHIP_UNEXPECTED:${JSON.stringify(value)}`);
  }
}

function assertNodeOverviewObject(
  html: string,
  objectId: string,
  status: string,
  ownerNodeId: string | null,
): void {
  const expectedAttributes = `data-object-id="${objectId}" data-object-status="${status}" data-owner-node-id="${ownerNodeId ?? ""}"`;
  if (!html.includes(expectedAttributes)) {
    throw new Error(`DEMO_OVERVIEW_OBJECT_UNEXPECTED:${expectedAttributes}`);
  }
}

function printJson(label: string, value: unknown): void {
  console.log(`${label}: ${JSON.stringify(value, null, 2)}`);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`DEMO_RECORD_INVALID:${name}`);
  }
  return value as Record<string, unknown>;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`DEMO_NUMBER_INVALID:${key}`);
  }
  return value;
}

await runNodeScenario();
