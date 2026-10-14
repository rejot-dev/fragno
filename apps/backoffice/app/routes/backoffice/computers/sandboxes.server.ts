import {
  SANDBOX_IMAGES,
  SANDBOX_INSTANCE_TYPES,
} from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";
import type { BackofficeRoutableScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";

import {
  requireBackofficeRouteScopeFromParams,
  type BackofficeRoutableRouteScope,
} from "@/backoffice-runtime/route-scope";
import { findBackofficeMe } from "@/fragno/auth/auth-server";
import type { SandboxRuntime } from "@/fragno/runtime-tools/families/sandbox-runtime";
import type { SandboxInstanceRecord } from "@/fragno/sandbox-manager/contracts";
import { isSandboxWorkspaceSnapshotResumable } from "@/fragno/sandbox-manager/workspace-snapshot";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "@/sandbox/contracts";
import { parseSleepAfterInput } from "@/sandbox/sleep-after";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";
import { getScopedSandboxRuntime } from "@/worker-runtime/sandbox-manager";

import { lookupAutomationProject } from "../automations/data.server";
import { automationRuntimeScopeFromRouteParams } from "../automations/scope";
import {
  DEFAULT_NEW_SANDBOX_VALUES,
  type NewSandboxFormValues,
  type SandboxView,
  type StartSandboxResult,
} from "./sandbox-model";

/** Opens the sandbox runtime of a route scope the signed-in user may use. */
export async function requireScopedSandboxRuntime({
  request,
  params,
  context,
}: {
  request: Request;
  params: { scopeKind?: string; scopeId?: string };
  context: Readonly<RouterContextProvider>;
}): Promise<{
  sandboxRuntime: SandboxRuntime;
  listSandboxes: () => Promise<SandboxView[]>;
  routeScope: BackofficeRoutableRouteScope;
}> {
  const scope = await requireSandboxScope({ request, params, context });
  const sandboxManager = context
    .get(BackofficeWorkerContext)
    .runtime.objects.sandboxManager.for(scope).commands;
  return {
    sandboxRuntime: getScopedSandboxRuntime(context, scope),
    // The agent-facing sandbox summary omits lifecycle details these pages show.
    listSandboxes: async () => {
      const instances = await sandboxManager.listSandboxInstances({
        provider: CLOUDFLARE_SANDBOX_PROVIDER,
      });
      const now = Date.now();
      // Newest first by creation, so rows keep their place while statuses change.
      return instances
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((instance) => toSandboxView(instance, now));
    },
    // requireSandboxScope rejected the system scope, so the route scope is routable.
    routeScope: requireBackofficeRouteScopeFromParams(params) as BackofficeRoutableRouteScope,
  };
}

async function requireSandboxScope({
  request,
  params,
  context,
}: {
  request: Request;
  params: { scopeKind?: string; scopeId?: string };
  context: Readonly<RouterContextProvider>;
}): Promise<BackofficeRoutableScope> {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const scope = automationRuntimeScopeFromRouteParams(
    params,
    me.organizations.map(({ organization }) => organization),
  );
  if (scope.kind === "system") {
    throw new Response("Not Found", { status: 404 });
  }

  if (scope.kind === "user") {
    if (scope.userId !== me.user.id) {
      throw new Response("Not Found", { status: 404 });
    }
    return scope;
  }

  const hasOrgAccess = me.organizations.some((entry) => entry.organization.id === scope.orgId);
  if (!hasOrgAccess) {
    throw new Response("Not Found", { status: 404 });
  }

  if (scope.kind === "project") {
    const projectLookup = await lookupAutomationProject(context, scope.orgId, scope.projectId);
    if (projectLookup.status === "error") {
      throw Response.json(
        {
          code: "AUTOMATION_PROJECT_UNAVAILABLE",
          message: projectLookup.message,
        },
        { status: 502, statusText: "Bad Gateway" },
      );
    }
    if (projectLookup.status === "not-found" || projectLookup.project.archivedAt) {
      throw new Response("Not Found", { status: 404 });
    }
  }

  return scope;
}

/** Starts a new sandbox, or resumes the one whose id the form names. */
export async function startSandboxFromForm(
  sandboxRuntime: SandboxRuntime,
  formData: FormData,
): Promise<StartSandboxResult> {
  const values = readNewSandboxFormValues(formData);
  const parsedSleepAfter = parseSleepAfterInput(values.sleepAfter);
  const image = readOptionalChoice(values.image, SANDBOX_IMAGES);
  const instanceType = readOptionalChoice(values.instanceType, SANDBOX_INSTANCE_TYPES);

  if (image === null || instanceType === null) {
    return { ok: false, message: "Choose an image and instance type from the list.", values };
  }
  if (!parsedSleepAfter.ok) {
    return { ok: false, message: parsedSleepAfter.message, values };
  }

  try {
    const instance = await sandboxRuntime.startSandbox({
      id: values.id || createSandboxId(),
      keepAlive: values.keepAlive,
      sleepAfter: parsedSleepAfter.value,
      startupCommand: values.startupCommand || "true",
      startupTimeoutMs: secondsToMilliseconds(values.startupTimeoutSeconds),
      image,
      instanceType,
    });
    return { ok: true, sandboxId: instance.id };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error), values };
  }
}

function readNewSandboxFormValues(formData: FormData): NewSandboxFormValues {
  return {
    id: readText(formData.get("id")),
    keepAlive: formData.get("keepAlive") === "on",
    sleepAfter: readText(formData.get("sleepAfter")),
    startupCommand:
      readText(formData.get("startupCommand")) || DEFAULT_NEW_SANDBOX_VALUES.startupCommand,
    startupTimeoutSeconds:
      readText(formData.get("startupTimeoutSeconds")) ||
      DEFAULT_NEW_SANDBOX_VALUES.startupTimeoutSeconds,
    image: readText(formData.get("image")),
    instanceType: readText(formData.get("instanceType")),
  };
}

/** Returns undefined for an omitted choice and null for one outside the allowed values. */
function readOptionalChoice<T extends string>(
  value: string,
  choices: readonly T[],
): T | undefined | null {
  if (!value) {
    return undefined;
  }
  return choices.find((choice) => choice === value) ?? null;
}

function toSandboxView(instance: SandboxInstanceRecord, now: number): SandboxView {
  return {
    id: instance.id,
    status: instance.status,
    image: instance.image,
    instanceType: instance.instanceType,
    workspaceSaved: isSandboxWorkspaceSnapshotResumable(instance.workspaceSnapshot, now),
    keepAlive: instance.keepAlive,
    sleepAfter: instance.sleepAfter,
    startupCommand: instance.startupCommand,
    startedAt: instance.startedAt,
    expectedStopAt: instance.expectedStopAt,
    stoppedAt: instance.stoppedAt,
    lastError: instance.lastError,
  };
}

export function secondsToMilliseconds(value: string): number | undefined {
  const seconds = toPositiveIntegerOrUndefined(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function toPositiveIntegerOrUndefined(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

export function readText(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function createSandboxId() {
  const random =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `cf-sbx-${Date.now().toString(36)}-${random}`;
}

export function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}
