import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  GraftControlStore,
  type GraftNodeLease,
  type GraftObjectOwnership,
} from "@fragno-private/backoffice-node-runtime/graft-control-store";
import {
  GraftObjectDirectory,
  provisionGraftControlDatabase,
  type GraftNodeRuntimeStorage,
} from "@fragno-private/backoffice-node-runtime/graft-object-directory";

/** Fixed object names provisioned before authority-bound control writes begin. */
export const runtimeShowcaseObjectNames = ["demo", "secondary"] as const;

export type RuntimeShowcaseStorage = {
  dataDirectory: string;
  cacheDirectory: string;
  remoteDirectory: string;
  storage: GraftNodeRuntimeStorage;
  persistedObjectIds: string[];
};

/** Creates or reopens the filesystem-backed Graft control log and process-local cache. */
export async function prepareRuntimeShowcaseStorage(
  dataDirectory: string,
): Promise<RuntimeShowcaseStorage> {
  const cacheDirectory = path.join(dataDirectory, "cache");
  const remoteDirectory = path.join(dataDirectory, "remote");
  const configPath = path.join(dataDirectory, "graft.toml");
  const controlRemoteLogIdPath = path.join(dataDirectory, "control-remote-log-id");
  await Promise.all([
    mkdir(cacheDirectory, { recursive: true }),
    mkdir(remoteDirectory, { recursive: true }),
  ]);
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
    { mode: 0o600 },
  );

  const existingControlRemoteLogId = await readControlRemoteLogId(controlRemoteLogIdPath);
  const controlRemoteLogId =
    existingControlRemoteLogId ?? provisionGraftControlDatabase(configPath);
  if (existingControlRemoteLogId === null) {
    await writeFile(controlRemoteLogIdPath, `${controlRemoteLogId}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  const storage = { configPath, controlRemoteLogId };
  const directory = new GraftObjectDirectory(storage);
  try {
    const provisionedObjectIds = new Set(directory.objectIds());
    for (const name of runtimeShowcaseObjectNames) {
      const objectId = `SHOWCASE:${name}`;
      if (!provisionedObjectIds.has(objectId)) {
        directory.resolveObjectRemoteLogId(objectId);
      }
    }
    return {
      dataDirectory,
      cacheDirectory,
      remoteDirectory,
      storage,
      persistedObjectIds: directory.objectIds(),
    };
  } finally {
    directory.close();
  }
}

/** Releases claims owned by this exact process generation after all workers have stopped. */
export function releaseRuntimeShowcaseObjectClaims(options: {
  storage: GraftNodeRuntimeStorage;
  nodeLease: GraftNodeLease;
  objectIds: readonly string[];
}): { objectId: string; outcome: string }[] {
  const controlStore = new GraftControlStore(options.storage);
  try {
    return [...new Set(options.objectIds)].map((objectId) => {
      const ownership = controlStore.readObjectOwnership(objectId);
      if (!isRuntimeShowcaseOwnedClaim(ownership, options.nodeLease)) {
        return { objectId, outcome: ownership?.state ?? "missing" };
      }
      const nowEpochMs = Date.now();
      const result = controlStore.releaseObject({
        commandId: randomUUID(),
        commandCreatedAtMs: nowEpochMs,
        input: {
          objectId,
          epoch: ownership.epoch,
          nodeId: options.nodeLease.nodeId,
          processGeneration: options.nodeLease.processGeneration,
          claimId: ownership.claimId,
          attemptedAtMs: nowEpochMs,
        },
      });
      return { objectId, outcome: result.outcome };
    });
  } finally {
    controlStore.close();
  }
}

/** Reads the durable control-plane ownership visible from a fresh Graft clone. */
export function readRuntimeShowcaseObjectOwnership(
  storage: GraftNodeRuntimeStorage,
  objectId: string,
): GraftObjectOwnership | null {
  const controlStore = new GraftControlStore(storage);
  try {
    return controlStore.readObjectOwnership(objectId);
  } finally {
    controlStore.close();
  }
}

async function readControlRemoteLogId(filePath: string): Promise<string | null> {
  try {
    const remoteLogId = (await readFile(filePath, "utf8")).trim();
    if (remoteLogId.length === 0) {
      throw new Error("RUNTIME_SHOWCASE_CONTROL_LOG_ID_EMPTY");
    }
    return remoteLogId;
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isRuntimeShowcaseOwnedClaim(
  ownership: GraftObjectOwnership | null,
  nodeLease: GraftNodeLease,
): ownership is Exclude<GraftObjectOwnership, { state: "unowned" }> {
  return (
    ownership !== null &&
    ownership.state !== "unowned" &&
    ownership.ownerNodeId === nodeLease.nodeId
  );
}
