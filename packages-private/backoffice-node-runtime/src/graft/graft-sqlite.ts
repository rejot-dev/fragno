import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { arch, platform } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { getLoadablePath } from "sqlite-graft";

import type { GraftDatabaseOperations } from "./graft-database-operations";

let initializedConfigPath: string | null = null;

function resolveGraftExtensionPath(): string {
  try {
    return getLoadablePath();
  } catch (error) {
    // sqlite-graft 0.2.1 looks for graft_ext while its Unix packages ship libgraft_ext.
    const packageDirectory = dirname(fileURLToPath(import.meta.resolve("sqlite-graft")));
    const os = platform === "win32" ? "windows" : platform;
    const suffix = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
    const extensionPath = join(
      packageDirectory,
      "..",
      `sqlite-graft-${os}-${arch}`,
      `libgraft_ext.${suffix}`,
    );
    if (!existsSync(extensionPath)) {
      throw error;
    }
    return extensionPath;
  }
}

/** Registers the pinned Graft VFS once for this Node process and configuration file. */
export function initializeGraftSqlite(configPath: string): void {
  const absoluteConfigPath = resolve(configPath);
  if (initializedConfigPath !== null) {
    if (initializedConfigPath !== absoluteConfigPath) {
      throw new Error(
        `GRAFT_SQLITE_ALREADY_INITIALIZED:${initializedConfigPath}:${absoluteConfigPath}`,
      );
    }
    return;
  }
  if (!existsSync(absoluteConfigPath)) {
    throw new Error(`GRAFT_SQLITE_CONFIG_MISSING:${absoluteConfigPath}`);
  }

  process.env["GRAFT_CONFIG"] = absoluteConfigPath;
  const bootstrap = new DatabaseSync(":memory:", { allowExtension: true });
  try {
    bootstrap.loadExtension(resolveGraftExtensionPath());
  } finally {
    bootstrap.close();
  }
  initializedConfigPath = absoluteConfigPath;
}

/** Opens a fresh local Graft volume whose remote log is created by its first push. */
export function openNewGraftDatabase(localTag: string): DatabaseSync {
  const database = new DatabaseSync(graftDatabaseUri(localTag));
  configureGraftDatabase(database);
  return database;
}

/** Opens a fresh local clone through the supplied Graft management operations. */
export function openClonedGraftDatabase(
  localTag: string,
  remoteLogId: string,
  operations: GraftDatabaseOperations,
): DatabaseSync {
  const database = openNewGraftDatabase(localTag);
  try {
    operations.clone(database, remoteLogId);
    operations.pull(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function configureGraftDatabase(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA journal_mode = MEMORY").get() as
    | Record<string, unknown>
    | undefined;
  if (!row || Object.values(row)[0] !== "memory") {
    throw new Error("GRAFT_SQLITE_MEMORY_JOURNAL_UNAVAILABLE");
  }
  database.exec("PRAGMA foreign_keys = ON");
}

function graftDatabaseUri(localTag: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(localTag)) {
    throw new Error(`GRAFT_SQLITE_INVALID_LOCAL_TAG:${localTag}`);
  }
  return `file:${localTag}?vfs=graft`;
}
