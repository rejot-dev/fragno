import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  resolveAutomationScriptPath,
  type AutomationScriptLayer,
} from "@/fragno/automation/automation-source";

const AUTOMATION_SCRIPT_ID_PREFIX = "automation-script:";

export function toAutomationScriptIdFromAbsolutePath(absolutePath: string): string {
  return `${AUTOMATION_SCRIPT_ID_PREFIX}${absolutePath}`;
}

/** Script ids arrive in URLs, so the path they carry is resolved like any script path. */
export function fromAutomationScriptId(value: string): string {
  return resolveAutomationScriptPath(
    value.startsWith(AUTOMATION_SCRIPT_ID_PREFIX)
      ? value.slice(AUTOMATION_SCRIPT_ID_PREFIX.length)
      : value,
  );
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
