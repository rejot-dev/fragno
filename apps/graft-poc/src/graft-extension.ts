import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { arch, platform } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** Load the Graft SQLite extension only after setting its process-wide configuration. */
export async function loadGraftExtension(): Promise<void> {
  const sqliteGraft = await import("sqlite-graft");
  let extensionPath;
  try {
    extensionPath = sqliteGraft.getLoadablePath();
  } catch (error) {
    // sqlite-graft 0.2.1 expects graft_ext; Unix packages ship libgraft_ext.
    const packageDirectory = dirname(fileURLToPath(import.meta.resolve("sqlite-graft")));
    const os = platform === "win32" ? "windows" : platform;
    const suffix = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
    extensionPath = join(
      packageDirectory,
      "..",
      `sqlite-graft-${os}-${arch}`,
      `libgraft_ext.${suffix}`,
    );
    if (!existsSync(extensionPath)) {
      throw error;
    }
  }
  const bootstrap = new DatabaseSync(":memory:", { allowExtension: true });
  try {
    bootstrap.loadExtension(extensionPath);
  } finally {
    bootstrap.close();
  }
}
