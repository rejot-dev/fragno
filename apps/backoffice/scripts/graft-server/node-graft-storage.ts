import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { provisionJournaledGraftControlDatabase } from "@fragno-private/backoffice-node-runtime/graft-control-database";
import type { GraftNodeRuntimeStorage } from "@fragno-private/backoffice-node-runtime/graft-runtime-storage";

/** Default development storage bootstraps locally; configured remotes and production require a published ID. */
export async function resolveNodeBackofficeGraftStorage(
  environment: Record<string, string | undefined>,
  workingDirectory: string = process.cwd(),
): Promise<GraftNodeRuntimeStorage> {
  const configuredPath = environment.GRAFT_CONFIG?.trim() || null;
  const controlRemoteLogId = environment.BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID?.trim() || null;
  const configPath = path.resolve(workingDirectory, configuredPath ?? "graft.toml");
  if (
    environment.NODE_ENV === "development" &&
    configuredPath === null &&
    (await readGraftFileIfPresent(configPath)) === null
  ) {
    return await provisionLocalBackofficeGraftStorage(
      path.resolve(workingDirectory, ".backoffice-graft"),
      controlRemoteLogId,
    );
  }
  if (controlRemoteLogId === null) {
    throw new Error(
      "BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID_REQUIRED: publish and persist a control log before starting Backoffice.",
    );
  }
  const metadata = await stat(configPath);
  if (!metadata.isFile()) {
    throw new Error("BACKOFFICE_GRAFT_CONFIG_NOT_FILE");
  }
  return { configPath, controlRemoteLogId };
}

async function provisionLocalBackofficeGraftStorage(
  directory: string,
  configuredRemoteLogId: string | null,
): Promise<GraftNodeRuntimeStorage> {
  const cacheDirectory = path.join(directory, "cache");
  const remoteDirectory = path.join(directory, "remote");
  const configPath = path.join(directory, "graft.toml");
  const controlLogPath = path.join(directory, "control-log-id");
  await Promise.all([
    mkdir(cacheDirectory, { recursive: true }),
    mkdir(remoteDirectory, { recursive: true }),
  ]);
  await syncLocalGraftDirectory(path.dirname(directory));
  const expectedConfig = [
    `data_dir = ${JSON.stringify(cacheDirectory)}`,
    "make_default = false",
    "",
    "[remote]",
    'type = "fs"',
    `root = ${JSON.stringify(remoteDirectory)}`,
    "",
  ].join("\n");
  const existingConfig = await readGraftFileIfPresent(configPath);
  if (existingConfig === null) {
    await publishLocalGraftFile(configPath, expectedConfig);
  } else if (existingConfig !== expectedConfig) {
    throw new Error(
      "BACKOFFICE_LOCAL_GRAFT_CONFIG_CHANGED: use GRAFT_CONFIG and an explicit control log ID for custom storage.",
    );
  }
  if (configuredRemoteLogId !== null) {
    return { configPath, controlRemoteLogId: configuredRemoteLogId };
  }
  const persistedId = await readGraftFileIfPresent(controlLogPath);
  const reservedRemoteLogId = persistedId?.trim() ?? null;
  if (reservedRemoteLogId === "") {
    throw new Error(
      "BACKOFFICE_LOCAL_GRAFT_CONTROL_LOG_ID_EMPTY: restore the original control log ID.",
    );
  }
  if (reservedRemoteLogId === null && (await readdir(remoteDirectory)).length > 0) {
    throw new Error(
      "BACKOFFICE_LOCAL_GRAFT_CONTROL_LOG_ID_MISSING: existing remote history requires its original control-log-id; refusing to create a replacement.",
    );
  }
  const controlRemoteLogId = await provisionJournaledGraftControlDatabase(
    configPath,
    reservedRemoteLogId,
    async function persistReservedControlLogId(remoteLogId) {
      // The ID and its directory entry must survive a crash before any remote history is published.
      await publishLocalGraftFile(controlLogPath, `${remoteLogId}\n`);
    },
  );
  return { configPath, controlRemoteLogId };
}

async function readGraftFileIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function publishLocalGraftFile(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}-${randomUUID()}.tmp`);
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    // An atomic, exclusive link cannot expose a partial ID or replace another startup's reservation.
    await link(temporaryPath, filePath);
    await syncLocalGraftDirectory(directory);
  } finally {
    await unlink(temporaryPath);
  }
}

async function syncLocalGraftDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}
