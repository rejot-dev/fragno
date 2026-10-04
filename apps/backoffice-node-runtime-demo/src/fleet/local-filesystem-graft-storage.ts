import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { provisionJournaledGraftControlDatabase } from "@fragno-private/backoffice-node-runtime/graft-control-database";
import type { GraftNodeRuntimeStorage } from "@fragno-private/backoffice-node-runtime/graft-runtime-storage";

/** Provisions filesystem storage for the local fleet and container examples. */
export async function provisionFilesystemGraftStorage(dataDirectory: string): Promise<{
  controlRemoteLogId: string;
}> {
  const remoteDirectory = path.join(dataDirectory, "remote");
  const bootstrapCacheDirectory = path.join(dataDirectory, "bootstrap-cache");
  const configPath = path.join(bootstrapCacheDirectory, "graft.toml");
  const controlRemoteLogIdPath = path.join(dataDirectory, "control-remote-log-id");
  await Promise.all([
    mkdir(remoteDirectory, { recursive: true }),
    mkdir(bootstrapCacheDirectory, { recursive: true }),
  ]);
  await writeFilesystemGraftConfig(configPath, bootstrapCacheDirectory, remoteDirectory);

  const reservationPath = path.join(dataDirectory, "bootstrap-reserved-control-log-id");
  const existingControlRemoteLogId = await readControlRemoteLogId(controlRemoteLogIdPath);
  const reservedRemoteLogId = await readControlRemoteLogId(reservationPath);
  if (
    existingControlRemoteLogId !== null &&
    reservedRemoteLogId !== null &&
    existingControlRemoteLogId !== reservedRemoteLogId
  ) {
    throw new Error("DEMO_CONTROL_LOCATOR_MISMATCH");
  }
  const controlRemoteLogId = await provisionJournaledGraftControlDatabase(
    configPath,
    existingControlRemoteLogId ?? reservedRemoteLogId,
    async function reserveFilesystemControlHistory(remoteLogId) {
      // A competing reservation fails before either contender can publish another fleet's history.
      await writeFile(reservationPath, `${remoteLogId}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    },
  );
  if (existingControlRemoteLogId === null) {
    await writeFile(controlRemoteLogIdPath, `${controlRemoteLogId}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }

  await rm(bootstrapCacheDirectory, { recursive: true, force: true });
  return { controlRemoteLogId };
}

/** Creates one disposable local cache configuration for the shared filesystem remote. */
export async function openFilesystemGraftStorage(
  dataDirectory: string,
  cacheDirectory: string,
): Promise<GraftNodeRuntimeStorage> {
  const remoteDirectory = path.join(dataDirectory, "remote");
  const configPath = path.join(cacheDirectory, "graft.toml");
  const controlRemoteLogId = await readControlRemoteLogId(
    path.join(dataDirectory, "control-remote-log-id"),
  );
  if (!controlRemoteLogId) {
    throw new Error("DEMO_FLEET_NOT_PROVISIONED");
  }
  await Promise.all([
    mkdir(remoteDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
  ]);
  await writeFilesystemGraftConfig(configPath, cacheDirectory, remoteDirectory);

  return { configPath, controlRemoteLogId };
}

async function writeFilesystemGraftConfig(
  configPath: string,
  cacheDirectory: string,
  remoteDirectory: string,
): Promise<void> {
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
}

async function readControlRemoteLogId(filePath: string): Promise<string | null> {
  try {
    const remoteLogId = (await readFile(filePath, "utf8")).trim();
    if (remoteLogId.length === 0) {
      throw new Error("DEMO_CONTROL_LOG_ID_EMPTY");
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
