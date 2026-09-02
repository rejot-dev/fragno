import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  AUTOMATION_STATIC_ROOT,
  AUTOMATION_SYSTEM_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
  getAutomationLayerForPath,
  type AutomationScriptLayer,
} from "@/fragno/automation/automation-source";

const AUTOMATION_SCRIPT_ID_PREFIX = "automation-script:";

function normalizeAutomationScriptPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  for (const root of [AUTOMATION_STATIC_ROOT, AUTOMATION_SYSTEM_ROOT, AUTOMATION_WORKSPACE_ROOT]) {
    const prefix = `${root}/`;
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }

  return trimmed.replace(/^\/+/, "");
}

function toAutomationScriptId(script: { layer: AutomationScriptLayer; path: string }): string {
  return `${AUTOMATION_SCRIPT_ID_PREFIX}${script.layer}:${normalizeAutomationScriptPath(script.path)}`;
}

export function toAutomationScriptIdFromAbsolutePath(absolutePath: string): string {
  return toAutomationScriptId({
    layer: getAutomationLayerForPath(absolutePath),
    path: absolutePath,
  });
}

export function fromAutomationScriptId(value: string): string {
  const normalized = value.startsWith(AUTOMATION_SCRIPT_ID_PREFIX)
    ? value.slice(AUTOMATION_SCRIPT_ID_PREFIX.length)
    : value;
  const [layer, ...pathParts] = normalized.split(":");
  const path = normalizeAutomationScriptPath(
    pathParts.length > 0 ? pathParts.join(":") : normalized,
  );

  if (layer === "static") {
    return `${AUTOMATION_STATIC_ROOT}/${path}`;
  }
  if (layer === "system") {
    return `${AUTOMATION_SYSTEM_ROOT}/${path}`;
  }
  if (layer === "workspace") {
    return `${AUTOMATION_WORKSPACE_ROOT}/${path}`;
  }

  return path;
}

export function isAutomationScriptLayerVisibleInScope(
  layer: AutomationScriptLayer,
  scope: BackofficeContextScope,
) {
  if (scope.kind === "system") {
    return layer === "system";
  }
  if (layer === "static") {
    return scope.kind === "org";
  }
  return layer === "workspace";
}
