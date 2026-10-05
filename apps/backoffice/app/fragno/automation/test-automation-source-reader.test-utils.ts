import type { IFileSystem } from "just-bash";

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

/** Snapshots automation source files without depending on synchronous remote path enumeration. */
export async function snapshotTestAutomationSourceReader(
  fileSystem: IFileSystem,
): Promise<AutomationSourceReader> {
  const files: Record<string, Uint8Array> = {};
  async function visit(path: string): Promise<void> {
    if (!(await fileSystem.exists(path))) {
      return;
    }
    if ((await fileSystem.stat(path)).isFile) {
      files[path] = await fileSystem.readFileBuffer(path);
      return;
    }
    for (const name of await fileSystem.readdir(path)) {
      await visit(`${path}/${name}`);
    }
  }
  for (const path of ["/static/automations", "/system/automations", "/workspace/automations"]) {
    await visit(path);
  }
  return createTestAutomationSourceReader(files);
}
