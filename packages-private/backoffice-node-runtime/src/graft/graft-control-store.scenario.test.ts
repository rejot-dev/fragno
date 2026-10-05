import { expect, test } from "vitest";

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  GraftClaimObjectInput,
  GraftControlCommand,
  GraftMarkObjectReadyInput,
  GraftNodeLease,
  GraftRegisterNodeInput,
  GraftRegisterObjectDatabaseInput,
  GraftReleaseObjectInput,
  GraftRenewNodeLeaseInput,
} from "./graft-control-store";

const executeFile = promisify(execFile);
const processFixture = new URL(
  "../testing/fixtures/graft-control-store-process.ts",
  import.meta.url,
);

type ProcessPushBehavior = "normal" | "fail-before-remote-commit" | "lose-response-after-commit";
type ControlStoreScenarioInvocation =
  | {
      operation: "register-node";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftRegisterNodeInput>;
    }
  | {
      operation: "renew-node-lease";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftRenewNodeLeaseInput>;
    }
  | {
      operation: "register-object-database";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftRegisterObjectDatabaseInput>;
    }
  | {
      operation: "claim-object";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftClaimObjectInput>;
    }
  | {
      operation: "mark-object-ready";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftMarkObjectReadyInput>;
    }
  | {
      operation: "release-object";
      pushBehavior: ProcessPushBehavior;
      command: GraftControlCommand<GraftReleaseObjectInput>;
    }
  | { operation: "read-object-ownership"; pushBehavior: "normal"; objectId: string }
  | { operation: "read-node-lease"; pushBehavior: "normal"; nodeId: string };

type ControlStoreScenario = {
  directory: string;
  remoteDirectory: string;
  controlRemoteLogId: string;
};

test("independent control clients serialize an object claim and reconcile a lost response", async () => {
  const scenario = await createControlStoreScenario("graft-control-claim-");
  try {
    const nodeA = createNodeLease("node-a", 10_000);
    const nodeB = createNodeLease("node-b", 10_000);
    const registrations = await Promise.all([
      registerNode(scenario, "register-node-a", nodeA),
      registerNode(scenario, "register-node-b", nodeB),
    ]);
    expect(registrations).toEqual([
      { outcome: "registered", lease: nodeA },
      { outcome: "registered", lease: nodeB },
    ]);
    await expect(
      registerNode(scenario, "register-node-invalid-origin", {
        ...createNodeLease("node-invalid-origin", 10_000),
        applicationOrigin: "http://node-invalid-origin.internal:8081/application-path",
      }),
    ).rejects.toThrow("GRAFT_CONTROL_NODE_APPLICATION_ORIGIN_INVALID");
    const registeredObject = await registerObjectDatabase(
      scenario,
      "register-object",
      "COUNTER:one",
      "object-log-one",
      "fail-before-remote-commit",
    );
    expect(registeredObject).toEqual({
      outcome: "registered",
      ownership: {
        state: "unowned",
        objectId: "COUNTER:one",
        remoteLogId: "object-log-one",
        epoch: "0",
      },
    });
    expect(
      await registerObjectDatabase(
        scenario,
        "register-object-after-lost-response",
        "COUNTER:lost-response",
        "object-log-after-lost-response",
        "lose-response-after-commit",
      ),
    ).toEqual({
      outcome: "registered",
      ownership: {
        state: "unowned",
        objectId: "COUNTER:lost-response",
        remoteLogId: "object-log-after-lost-response",
        epoch: "0",
      },
    });
    await expect(
      runControlStoreProcess(scenario, "reused-register-command", {
        operation: "register-object-database",
        pushBehavior: "normal",
        command: createControlCommand<GraftRegisterObjectDatabaseInput>("register-object", 0, {
          objectId: "COUNTER:other",
          remoteLogId: "object-log-other",
        }),
      }),
    ).rejects.toThrow("GRAFT_CONTROL_COMMAND_ID_REUSED:register-object");

    const claimCommands = [
      createControlCommand<GraftClaimObjectInput>("claim-node-a", 100, {
        objectId: "COUNTER:one",
        observedEpoch: "0",
        nodeId: nodeA.nodeId,
        processGeneration: nodeA.processGeneration,
        claimId: "claim-a",
        attemptedAtMs: 100,
        ownerLeaseExpiryCutoffMs: 100,
      }),
      createControlCommand<GraftClaimObjectInput>("claim-node-b", 100, {
        objectId: "COUNTER:one",
        observedEpoch: "0",
        nodeId: nodeB.nodeId,
        processGeneration: nodeB.processGeneration,
        claimId: "claim-b",
        attemptedAtMs: 100,
        ownerLeaseExpiryCutoffMs: 100,
      }),
    ];
    const claimResults = await Promise.all(
      claimCommands.map((command, index) =>
        runControlStoreProcess(scenario, `claim-${index}`, {
          operation: "claim-object",
          pushBehavior: "normal",
          command,
        }),
      ),
    );
    const successfulClaims = claimResults.filter(
      (result) => readString(result, "outcome") === "claimed",
    );
    const rejectedClaims = claimResults.filter(
      (result) => readString(result, "outcome") === "ownership-changed",
    );
    expect(successfulClaims).toHaveLength(1);
    expect(rejectedClaims).toHaveLength(1);

    const claimedOwnership = readRecord(successfulClaims[0] ?? {}, "ownership");
    const winningNodeId = readString(claimedOwnership, "ownerNodeId");
    const winningNode = winningNodeId === nodeA.nodeId ? nodeA : nodeB;
    const winningClaimId = readString(claimedOwnership, "claimId");
    expect(claimedOwnership).toMatchObject({
      state: "restoring",
      objectId: "COUNTER:one",
      remoteLogId: "object-log-one",
      epoch: "1",
    });

    const restoredClaim = await readObjectOwnership(scenario, "restored-claim", "COUNTER:one");
    expect(restoredClaim).toEqual(claimedOwnership);

    const readyCommand = createControlCommand<GraftMarkObjectReadyInput>("mark-ready", 200, {
      objectId: "COUNTER:one",
      epoch: "1",
      nodeId: winningNode.nodeId,
      processGeneration: winningNode.processGeneration,
      claimId: winningClaimId,
      attemptedAtMs: 200,
    });
    const readyAfterLostResponse = await runControlStoreProcess(
      scenario,
      "mark-ready-lost-response",
      {
        operation: "mark-object-ready",
        pushBehavior: "lose-response-after-commit",
        command: readyCommand,
      },
    );
    expect(readyAfterLostResponse).toMatchObject({
      outcome: "ready",
      ownership: {
        state: "ready",
        objectId: "COUNTER:one",
        epoch: "1",
        ownerNodeId: winningNode.nodeId,
        claimId: winningClaimId,
      },
    });

    const repeatedReadyCommand = await runControlStoreProcess(scenario, "mark-ready-repeat", {
      operation: "mark-object-ready",
      pushBehavior: "normal",
      command: readyCommand,
    });
    expect(repeatedReadyCommand).toEqual(readyAfterLostResponse);

    const renewedLease = await runControlStoreProcess(scenario, "renew-winner", {
      operation: "renew-node-lease",
      pushBehavior: "lose-response-after-commit",
      command: createControlCommand<GraftRenewNodeLeaseInput>("renew-winner", 300, {
        nodeId: winningNode.nodeId,
        processGeneration: winningNode.processGeneration,
        expectedRenewalId: winningNode.renewalId,
        nextRenewalId: "renewal-2",
        attemptedAtMs: 300,
        expiresAtMs: 20_000,
      }),
    });
    expect(renewedLease).toMatchObject({
      outcome: "renewed",
      lease: {
        nodeId: winningNode.nodeId,
        renewalId: "renewal-2",
        expiresAtMs: 20_000,
      },
    });
    expect(await readNodeLease(scenario, "restored-renewal", winningNode.nodeId)).toMatchObject({
      nodeId: winningNode.nodeId,
      renewalId: "renewal-2",
      expiresAtMs: 20_000,
    });

    const released = await runControlStoreProcess(scenario, "release-object", {
      operation: "release-object",
      pushBehavior: "normal",
      command: createControlCommand<GraftReleaseObjectInput>("release-object", 400, {
        objectId: "COUNTER:one",
        epoch: "1",
        nodeId: winningNode.nodeId,
        processGeneration: winningNode.processGeneration,
        claimId: winningClaimId,
        attemptedAtMs: 400,
      }),
    });
    expect(released).toEqual({
      outcome: "released",
      ownership: {
        state: "unowned",
        objectId: "COUNTER:one",
        remoteLogId: "object-log-one",
        epoch: "1",
      },
    });
    expect(await readObjectOwnership(scenario, "restored-release", "COUNTER:one")).toEqual(
      released["ownership"],
    );
  } finally {
    await rm(scenario.directory, { recursive: true, force: true });
  }
}, 15_000);

test("an expired owner can be replaced while its late completion is rejected", async () => {
  const scenario = await createControlStoreScenario("graft-control-takeover-");
  try {
    const oldNode = createNodeLease("old-node", 500);
    const newNode = createNodeLease("new-node", 10_000);
    await registerNode(scenario, "register-old-node", oldNode);
    await registerNode(scenario, "register-new-node", newNode);
    await registerObjectDatabase(
      scenario,
      "register-takeover-object",
      "COUNTER:one",
      "object-log-one",
      "normal",
    );

    const oldClaim = await runControlStoreProcess(scenario, "old-claim", {
      operation: "claim-object",
      pushBehavior: "normal",
      command: createControlCommand<GraftClaimObjectInput>("old-claim", 100, {
        objectId: "COUNTER:one",
        observedEpoch: "0",
        nodeId: oldNode.nodeId,
        processGeneration: oldNode.processGeneration,
        claimId: "old-claim",
        attemptedAtMs: 100,
        ownerLeaseExpiryCutoffMs: 100,
      }),
    });
    expect(oldClaim).toMatchObject({ outcome: "claimed", ownership: { epoch: "1" } });

    const earlyTakeover = await runControlStoreProcess(scenario, "early-new-claim", {
      operation: "claim-object",
      pushBehavior: "normal",
      command: createControlCommand<GraftClaimObjectInput>("early-new-claim", 599, {
        objectId: "COUNTER:one",
        observedEpoch: "1",
        nodeId: newNode.nodeId,
        processGeneration: newNode.processGeneration,
        claimId: "early-new-claim",
        attemptedAtMs: 599,
        ownerLeaseExpiryCutoffMs: 499,
      }),
    });
    expect(earlyTakeover).toMatchObject({
      outcome: "current-owner-live",
      ownership: { epoch: "1", ownerNodeId: oldNode.nodeId },
    });

    const lateRenewal = await runControlStoreProcess(scenario, "late-old-renewal", {
      operation: "renew-node-lease",
      pushBehavior: "normal",
      command: createControlCommand<GraftRenewNodeLeaseInput>("late-old-renewal", 600, {
        nodeId: oldNode.nodeId,
        processGeneration: oldNode.processGeneration,
        expectedRenewalId: oldNode.renewalId,
        nextRenewalId: "late-renewal",
        attemptedAtMs: 600,
        expiresAtMs: 10_000,
      }),
    });
    expect(lateRenewal).toMatchObject({
      outcome: "lease-expired",
      lease: { nodeId: oldNode.nodeId, expiresAtMs: 500, renewalId: oldNode.renewalId },
    });

    const takeover = await runControlStoreProcess(scenario, "new-claim", {
      operation: "claim-object",
      pushBehavior: "normal",
      command: createControlCommand<GraftClaimObjectInput>("new-claim", 600, {
        objectId: "COUNTER:one",
        observedEpoch: "1",
        nodeId: newNode.nodeId,
        processGeneration: newNode.processGeneration,
        claimId: "new-claim",
        attemptedAtMs: 600,
        ownerLeaseExpiryCutoffMs: 500,
      }),
    });
    expect(takeover).toEqual({
      outcome: "claimed",
      ownership: {
        state: "restoring",
        objectId: "COUNTER:one",
        remoteLogId: "object-log-one",
        epoch: "2",
        ownerNodeId: newNode.nodeId,
        claimId: "new-claim",
      },
    });

    const lateOldReady = await runControlStoreProcess(scenario, "late-old-ready", {
      operation: "mark-object-ready",
      pushBehavior: "normal",
      command: createControlCommand<GraftMarkObjectReadyInput>("late-old-ready", 601, {
        objectId: "COUNTER:one",
        epoch: "1",
        nodeId: oldNode.nodeId,
        processGeneration: oldNode.processGeneration,
        claimId: "old-claim",
        attemptedAtMs: 400,
      }),
    });
    expect(lateOldReady).toEqual({
      outcome: "ownership-changed",
      ownership: takeover["ownership"],
    });
    expect(await readObjectOwnership(scenario, "restored-takeover", "COUNTER:one")).toEqual(
      takeover["ownership"],
    );
  } finally {
    await rm(scenario.directory, { recursive: true, force: true });
  }
}, 15_000);

function createNodeLease(nodeId: string, expiresAtMs: number): GraftNodeLease {
  return {
    nodeId,
    processGeneration: `${nodeId}-generation`,
    privateAddress: `${nodeId}.internal:8081`,
    applicationOrigin: `http://${nodeId}.internal:8081`,
    compatibilityVersion: 1,
    expiresAtMs,
    renewalId: "renewal-1",
  };
}

function createControlCommand<TInput>(
  commandId: string,
  commandCreatedAtMs: number,
  input: TInput,
): GraftControlCommand<TInput> {
  return { commandId, commandCreatedAtMs, input };
}

async function createControlStoreScenario(prefix: string): Promise<ControlStoreScenario> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const remoteDirectory = path.join(directory, "remote");
  await mkdir(remoteDirectory);
  const configPath = await writeGraftConfig(directory, "provision", remoteDirectory);
  const provision = await runControlStoreFixture("provision", configPath);
  return {
    directory,
    remoteDirectory,
    controlRemoteLogId: readString(provision, "controlRemoteLogId"),
  };
}

async function registerNode(
  scenario: ControlStoreScenario,
  name: string,
  lease: GraftNodeLease,
): Promise<Record<string, unknown>> {
  return runControlStoreProcess(scenario, name, {
    operation: "register-node",
    pushBehavior: "normal",
    command: createControlCommand<GraftRegisterNodeInput>(name, 0, { lease }),
  });
}

async function registerObjectDatabase(
  scenario: ControlStoreScenario,
  name: string,
  objectId: string,
  remoteLogId: string,
  pushBehavior: ProcessPushBehavior,
): Promise<Record<string, unknown>> {
  return runControlStoreProcess(scenario, name, {
    operation: "register-object-database",
    pushBehavior,
    command: createControlCommand<GraftRegisterObjectDatabaseInput>(name, 0, {
      objectId,
      remoteLogId,
    }),
  });
}

async function readObjectOwnership(
  scenario: ControlStoreScenario,
  name: string,
  objectId: string,
): Promise<Record<string, unknown>> {
  return runControlStoreProcess(scenario, name, {
    operation: "read-object-ownership",
    pushBehavior: "normal",
    objectId,
  });
}

async function readNodeLease(
  scenario: ControlStoreScenario,
  name: string,
  nodeId: string,
): Promise<Record<string, unknown>> {
  return runControlStoreProcess(scenario, name, {
    operation: "read-node-lease",
    pushBehavior: "normal",
    nodeId,
  });
}

async function runControlStoreProcess(
  scenario: ControlStoreScenario,
  name: string,
  invocation: ControlStoreScenarioInvocation,
): Promise<Record<string, unknown>> {
  return runControlStoreFixture(
    "execute",
    await writeGraftConfig(scenario.directory, name, scenario.remoteDirectory),
    scenario.controlRemoteLogId,
    invocation,
  );
}

async function writeGraftConfig(
  directory: string,
  name: string,
  remoteDirectory: string,
): Promise<string> {
  const cacheDirectory = path.join(directory, `${name}-cache`);
  await mkdir(cacheDirectory, { recursive: true });
  const configPath = path.join(directory, `${name}.toml`);
  await writeFile(
    configPath,
    [
      `data_dir = ${JSON.stringify(cacheDirectory)}`,
      "make_default = false",
      "",
      "[remote]",
      'type = "fs"',
      `root = ${JSON.stringify(remoteDirectory)}`,
      "",
    ].join("\n"),
  );
  return configPath;
}

async function runControlStoreFixture(
  processCommand: "provision" | "execute",
  configPath: string,
  controlRemoteLogId?: string,
  invocation?: ControlStoreScenarioInvocation,
): Promise<Record<string, unknown>> {
  const arguments_ = [processFixture.pathname, processCommand, configPath];
  if (controlRemoteLogId) {
    arguments_.push(controlRemoteLogId);
  }
  if (invocation) {
    arguments_.push(JSON.stringify(invocation));
  }
  const { stdout } = await executeFile(process.execPath, arguments_, {
    cwd: path.dirname(processFixture.pathname),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const resultLine = stdout
    .split("\n")
    .find((line) => line.startsWith("GRAFT_CONTROL_STORE_RESULT:"));
  if (!resultLine) {
    throw new Error(`GRAFT_CONTROL_STORE_PROCESS_RESULT_MISSING:${stdout}`);
  }
  const result = JSON.parse(resultLine.slice("GRAFT_CONTROL_STORE_RESULT:".length)) as unknown;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("GRAFT_CONTROL_STORE_PROCESS_RESULT_INVALID");
  }
  return result as Record<string, unknown>;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GRAFT_CONTROL_STORE_PROCESS_RECORD_MISSING:${key}`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`GRAFT_CONTROL_STORE_PROCESS_STRING_MISSING:${key}`);
  }
  return value;
}
