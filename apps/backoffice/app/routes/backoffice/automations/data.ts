import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { getAutomationsDurableObject } from "@/cloudflare/cloudflare-utils";
import { createOrgFileSystem } from "@/files";
import {
  AUTOMATION_WORKSPACE_ROOT,
  listAutomationWorkspaceScripts,
  readAutomationWorkspaceScript,
  type AutomationWorkspaceScriptEntry,
  type createAutomationFragment,
} from "@/fragno/automation";
import type { AutomationScriptEngine } from "@/fragno/automation/catalog";

import {
  booleanActionResultFromCaughtError,
  booleanActionResultFromRouteResponse,
} from "../action-result";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

type AutomationIdLike =
  | string
  | {
      externalId?: string | null;
      id?: string | null;
    }
  | null
  | undefined;

export type AutomationScriptRecord = {
  id: string;
  key: string;
  name: string;
  engine: AutomationScriptEngine;
  path: string;
  absolutePath: string;
  version: number | null;
  scriptLoadError?: string | null;
  enabled: boolean;
};

export type AutomationStoreEntryRecord = {
  id?: AutomationIdLike;
  key?: string | null;
  value?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export type AutomationScriptSourceRecord = {
  script: string | null;
  scriptError: string | null;
};

const AUTOMATION_SCRIPT_ID_PREFIX = "workspace-script:";
const formatErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const isSuccessStatus = (status: number) => status >= 200 && status < 300;

const createAutomationsRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const automationsDo = getAutomationsDurableObject(context, orgId);
  return createRouteCaller<AutomationFragment>({
    baseUrl: request.url,
    mountRoute: "/api/automations/bindings",
    baseHeaders: request.headers,
    fetch: async (outboundRequest) => {
      const url = new URL(outboundRequest.url);
      url.searchParams.set("orgId", orgId);
      return automationsDo.fetch(new Request(url.toString(), outboundRequest));
    },
  });
};

const toRecordArray = <T extends Record<string, unknown>>(value: unknown): T[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is T => Boolean(item) && typeof item === "object");
};

const createBackofficeAutomationFileSystem = async ({
  context,
  orgId,
}: {
  context: Readonly<RouterContextProvider>;
  orgId: string;
}) => {
  const { env } = context.get(CloudflareContext);
  return createOrgFileSystem({ orgId, env });
};

const normalizeAutomationScriptPath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const workspacePrefix = `${AUTOMATION_WORKSPACE_ROOT}/`;
  if (trimmed.startsWith(workspacePrefix)) {
    return trimmed.slice(workspacePrefix.length);
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

const buildWorkspaceScriptRecord = (
  script: AutomationWorkspaceScriptEntry,
): AutomationScriptRecord => ({
  id: toAutomationScriptId(script.path),
  key: buildAutomationScriptKey(script.path),
  name: buildAutomationScriptName(script.path),
  engine: script.engine,
  path: script.path,
  absolutePath: script.absolutePath,
  version: null,
  scriptLoadError: null,
  enabled: script.kind === "script",
});

export const toAutomationScriptId = (path: string): string =>
  `${AUTOMATION_SCRIPT_ID_PREFIX}${normalizeAutomationScriptPath(path)}`;

export const fromAutomationScriptId = (value: string): string =>
  value.startsWith(AUTOMATION_SCRIPT_ID_PREFIX)
    ? value.slice(AUTOMATION_SCRIPT_ID_PREFIX.length)
    : normalizeAutomationScriptPath(value);

export const toExternalId = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if ("externalId" in value && typeof value.externalId === "string") {
    return value.externalId;
  }

  if ("id" in value && typeof value.id === "string") {
    return value.id;
  }

  return "";
};

export async function loadAutomationWorkspaceData({
  context,
  orgId,
}: {
  context: Readonly<RouterContextProvider>;
  orgId: string;
}): Promise<{
  scripts: AutomationScriptRecord[];
  scriptsError: string | null;
}> {
  const fileSystem = await createBackofficeAutomationFileSystem({ context, orgId });

  let workspaceScripts: AutomationWorkspaceScriptEntry[] = [];
  let workspaceScriptsError: string | null = null;
  try {
    workspaceScripts = await listAutomationWorkspaceScripts(fileSystem);
  } catch (error) {
    workspaceScriptsError = formatErrorMessage(error, "Failed to list automation scripts.");
  }

  return {
    scripts: workspaceScripts
      .map(buildWorkspaceScriptRecord)
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
      ),
    scriptsError: workspaceScriptsError,
  };
}

export async function loadAutomationScriptSource({
  context,
  orgId,
  scriptId,
}: {
  context: Readonly<RouterContextProvider>;
  orgId: string;
  scriptId: string;
}): Promise<AutomationScriptSourceRecord> {
  const fileSystem = await createBackofficeAutomationFileSystem({ context, orgId });

  try {
    const script = await readAutomationWorkspaceScript(
      fileSystem,
      fromAutomationScriptId(scriptId),
    );
    return {
      script: script.body,
      scriptError: null,
    };
  } catch (error) {
    return {
      script: null,
      scriptError: formatErrorMessage(error, "Failed to load automation script source."),
    };
  }
}

export async function fetchAutomationStoreEntries(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<{
  storeEntries: AutomationStoreEntryRecord[];
  storeEntriesError: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/store");

    if (response.type === "json" && isSuccessStatus(response.status)) {
      return {
        storeEntries: toRecordArray<AutomationStoreEntryRecord>(response.data),
        storeEntriesError: null,
      };
    }

    if (response.type === "error") {
      return {
        storeEntries: [],
        storeEntriesError: response.error.message,
      };
    }

    return {
      storeEntries: [],
      storeEntriesError: `Failed to fetch automation store entries (${response.status}).`,
    };
  } catch (error) {
    return {
      storeEntries: [],
      storeEntriesError: formatErrorMessage(error, "Failed to load automation store entries."),
    };
  }
}

export async function deleteAutomationStoreEntry(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  key: string,
): Promise<{
  ok: boolean;
  error: string | null;
}> {
  try {
    const callRoute = createAutomationsRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/store/delete", {
      body: { key },
    });

    return booleanActionResultFromRouteResponse({
      response,
      failureMessage: "Failed to delete automation store entry",
      requireSuccessStatus: true,
    });
  } catch (error) {
    return booleanActionResultFromCaughtError(error, "Failed to delete automation store entry.");
  }
}
