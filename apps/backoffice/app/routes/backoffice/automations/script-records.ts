import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import { isUploadDirectoryMarker } from "@/files/contributors/upload-markers";
import {
  AUTOMATION_STATIC_ROOT,
  AUTOMATION_SYSTEM_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
  inferWorkspaceScriptEngine,
  type AutomationWorkspaceScriptEntry,
} from "@/fragno/automation/catalog";
import type { UploadFileRecord } from "@/fragno/upload/file-record";

import type { AutomationScriptRecord } from "./data";

const AUTOMATION_SCRIPT_ID_PREFIX = "automation-script:";
const WORKSPACE_UPLOAD_PREFIX = "automations/";

const normalizeAutomationScriptPath = (value: string) => {
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
};

const buildAutomationScriptKey = (path: string) => {
  const normalizedPath = normalizeAutomationScriptPath(path);
  const withoutScriptsRoot = normalizedPath.replace(/^scripts\//, "");
  const withoutExtension = withoutScriptsRoot.replace(/\.[^.]+$/, "");
  return withoutExtension || normalizedPath;
};

const buildAutomationScriptName = (path: string) => {
  const key = buildAutomationScriptKey(path);
  const segments = key
    .split(/[/._-]+/)
    .filter(Boolean)
    .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`);

  return segments.join(" ") || path;
};

const toAutomationScriptId = (
  script: Pick<AutomationWorkspaceScriptEntry, "layer" | "path">,
): string =>
  `${AUTOMATION_SCRIPT_ID_PREFIX}${script.layer}:${normalizeAutomationScriptPath(script.path)}`;

export const fromAutomationScriptId = (value: string): string => {
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
};

export const isAutomationScriptLayerVisibleInScope = (
  layer: AutomationWorkspaceScriptEntry["layer"],
  scope: BackofficeContextScope,
) => {
  if (scope.kind === "system") {
    return layer === "system";
  }
  if (layer === "static") {
    return scope.kind === "org";
  }
  return layer === "workspace";
};

export const buildAutomationScriptRecord = (
  script: AutomationWorkspaceScriptEntry,
): AutomationScriptRecord => ({
  id: toAutomationScriptId(script),
  layer: script.layer,
  readOnly: script.layer === "static" || script.layer === "system",
  key: buildAutomationScriptKey(script.path),
  name: buildAutomationScriptName(script.path),
  engine: script.engine,
  path: script.path,
  absolutePath: script.absolutePath,
  version: null,
  scriptLoadError: null,
  enabled: script.kind === "script",
});

export const buildUploadWorkspaceScriptRecords = (
  files: readonly UploadFileRecord[],
): AutomationScriptRecord[] =>
  files
    .flatMap((file) => {
      if (
        file.provider !== "database" ||
        file.status !== "ready" ||
        isUploadDirectoryMarker(file) ||
        !file.fileKey.startsWith(WORKSPACE_UPLOAD_PREFIX)
      ) {
        return [];
      }

      const path = file.fileKey.slice(WORKSPACE_UPLOAD_PREFIX.length);
      if (!path) {
        return [];
      }

      return [
        buildAutomationScriptRecord({
          layer: "workspace",
          path,
          absolutePath: `${AUTOMATION_WORKSPACE_ROOT}/${path}`,
          engine: inferWorkspaceScriptEngine(path),
          kind: path.endsWith(".workflow.js") ? "workflow" : "script",
        }),
      ];
    })
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
    );
