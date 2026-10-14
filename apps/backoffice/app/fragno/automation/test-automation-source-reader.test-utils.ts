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
