import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { normalizeRelativePath } from "@/files";

export const AUTOMATION_STATIC_ROOT = "/static/automations";
export const AUTOMATION_SYSTEM_ROOT = "/system/automations";
export const AUTOMATION_WORKSPACE_ROOT = "/workspace/automations";

const AUTOMATION_ROOTS = [
  AUTOMATION_STATIC_ROOT,
  AUTOMATION_SYSTEM_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
] as const;
const AUTOMATION_ROOT_RELATIVE_PATHS = AUTOMATION_ROOTS.map((root) => root.slice(1));

export type AutomationSourceReader = (input: {
  execution: BackofficeExecutionContext;
  path: string;
}) => Promise<string> | string;

export type AutomationScriptLayer = "static" | "system" | "workspace";

export function normalizeScriptRelativePath(value: string, label = "Automation script"): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} path is empty.`);
  }

  if (trimmed.startsWith("/")) {
    let normalizedAbsolutePath: string;
    try {
      normalizedAbsolutePath = normalizeRelativePath(trimmed.slice(1));
    } catch (error) {
      throw new Error(
        `${label} path '${value}' is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const matchedRoot = AUTOMATION_ROOT_RELATIVE_PATHS.find(
      (root) => normalizedAbsolutePath === root || normalizedAbsolutePath.startsWith(`${root}/`),
    );
    if (!matchedRoot) {
      throw new Error(`${label} path '${value}' must stay under an automation root.`);
    }
    return normalizedAbsolutePath.slice(`${matchedRoot}/`.length);
  }

  try {
    return normalizeRelativePath(trimmed);
  } catch (error) {
    throw new Error(
      `${label} path '${value}' is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function toAbsoluteAutomationPath(relativePath: string): string {
  return `${AUTOMATION_WORKSPACE_ROOT}/${normalizeRelativePath(relativePath)}`;
}

export function getAutomationLayerForPath(absolutePath: string): AutomationScriptLayer {
  if (absolutePath.startsWith(`${AUTOMATION_STATIC_ROOT}/`)) {
    return "static";
  }
  if (absolutePath.startsWith(`${AUTOMATION_SYSTEM_ROOT}/`)) {
    return "system";
  }
  return "workspace";
}

export async function readAutomationScript(
  readAutomationSource: AutomationSourceReader,
  input: { execution: BackofficeExecutionContext; scriptPath: string },
): Promise<{ absolutePath: string; body: string }> {
  const trimmedPath = input.scriptPath.trim();
  const normalizedPath = normalizeScriptRelativePath(trimmedPath, trimmedPath || "script");
  const absolutePath = trimmedPath.startsWith("/")
    ? `/${normalizeRelativePath(trimmedPath.slice(1))}`
    : toAbsoluteAutomationPath(normalizedPath);
  return {
    absolutePath,
    body: await readAutomationSource({ execution: input.execution, path: absolutePath }),
  };
}
