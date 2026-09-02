import type { IFileSystem } from "@/files";
import { FileSystemError } from "@/files/fs-errors";

import type { AutomationSourceReader } from "./automation-source";

/** Creates an automation source reader from absolute test file paths. */
export function createTestAutomationSourceReader(
  files: Readonly<Record<string, string | Uint8Array>>,
): AutomationSourceReader {
  const contents = new Map(
    Object.entries(files).map(([path, content]) => [
      path,
      typeof content === "string" ? content : new TextDecoder().decode(content),
    ]),
  );

  return async ({ path }) => {
    const content = contents.get(path);
    if (content === undefined) {
      throw new Error(`Test automation source '${path}' was not found.`);
    }
    return content;
  };
}

/** Snapshots automation source files from a mutable test filesystem. */
export async function snapshotTestAutomationSourceReader(
  fileSystem: IFileSystem,
): Promise<AutomationSourceReader> {
  const files: Record<string, Uint8Array> = {};

  for (const path of fileSystem.getAllPaths()) {
    if (
      !path.startsWith("/static/automations/") &&
      !path.startsWith("/system/automations/") &&
      !path.startsWith("/workspace/automations/")
    ) {
      continue;
    }

    try {
      const stat = await fileSystem.stat(path);
      if (stat.isFile) {
        files[path] = await fileSystem.readFileBuffer(path);
      }
    } catch (error) {
      if (error instanceof FileSystemError && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return createTestAutomationSourceReader(files);
}
