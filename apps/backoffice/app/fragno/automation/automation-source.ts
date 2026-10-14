import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { isPathWithin, normalizeRelativePath } from "@/files/normalize-path";

export const AUTOMATION_STATIC_ROOT = "/static/automations";
export const AUTOMATION_SYSTEM_ROOT = "/system/automations";
export const AUTOMATION_WORKSPACE_ROOT = "/workspace/automations";

// Marketplace packages install into a chosen workspace folder, so workspace scripts may live
// anywhere in the workspace. Static and system scripts stay in their automation folders.
const AUTOMATION_SCRIPT_ROOTS = [AUTOMATION_STATIC_ROOT, AUTOMATION_SYSTEM_ROOT, "/workspace"];

export type AutomationSourceReader = (input: {
  execution: BackofficeExecutionContext;
  path: string;
}) => Promise<string> | string;

export type AutomationScriptLayer = "static" | "system" | "workspace";

/** Resolves a script path to an absolute one; relative paths are in the workspace automations folder. */
export function resolveAutomationScriptPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Automation script path is empty.");
  }

  let absolutePath: string;
  try {
    absolutePath = trimmed.startsWith("/")
      ? `/${normalizeRelativePath(trimmed.slice(1))}`
      : toAbsoluteAutomationPath(trimmed);
  } catch (error) {
    throw new Error(
      `Automation script path '${value}' is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    !AUTOMATION_SCRIPT_ROOTS.some(
      (root) => absolutePath !== root && isPathWithin(absolutePath, root),
    )
  ) {
    throw new Error(
      `Automation script path '${value}' must be in the workspace or an automation folder.`,
    );
  }
  return absolutePath;
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
  const absolutePath = resolveAutomationScriptPath(input.scriptPath);
  return {
    absolutePath,
    body: await readAutomationSource({ execution: input.execution, path: absolutePath }),
  };
}
