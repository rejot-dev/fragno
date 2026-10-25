import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type {
  BackofficeObjectBindingName,
  BackofficeObjectScopeKind,
} from "@/backoffice-runtime/object-registry";
import {
  isBackofficeObjectAvailableInContext,
  isBackofficeObjectScopeAllowed,
} from "@/backoffice-runtime/object-registry";
import {
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeRouteScope } from "@/backoffice-runtime/route-scope";

import { internalsScopeBasePath } from "./internals-scope";

export const DURABLE_HOOK_OBJECT_DEFINITIONS = [
  { id: "api", binding: "API", label: "API" },
  { id: "auth", binding: "AUTH", label: "Auth" },
  { id: "forms", binding: "FORMS", label: "Forms" },
  { id: "automations", binding: "AUTOMATIONS", label: "Automations" },
  { id: "telegram", binding: "TELEGRAM", label: "Telegram" },
  { id: "otp", binding: "OTP", label: "OTP" },
  { id: "resend", binding: "RESEND", label: "Resend" },
  { id: "mcp", binding: "MCP", label: "MCP" },
  { id: "upload", binding: "UPLOAD", label: "Upload" },
  { id: "github", binding: "GITHUB", label: "GitHub" },
  { id: "workflows", binding: "AUTOMATIONS", label: "Workflows" },
] as const satisfies readonly {
  id: string;
  binding: BackofficeObjectBindingName;
  label: string;
}[];

export type DurableHooksObjectId = (typeof DURABLE_HOOK_OBJECT_DEFINITIONS)[number]["id"];
export type DurableHooksObjectDefinition = (typeof DURABLE_HOOK_OBJECT_DEFINITIONS)[number];

export type DurableHooksScopeSelection =
  | {
      kind: "singleton";
      label: "Singleton";
      resolvedScope: Extract<BackofficeResolvedScope, { kind: "system" }>;
      objectId: DurableHooksObjectId;
    }
  | {
      kind: "org";
      label: string;
      resolvedScope: Extract<BackofficeResolvedScope, { kind: "org" }>;
      objectId: DurableHooksObjectId;
    }
  | {
      kind: "user";
      label: string;
      resolvedScope: Extract<BackofficeResolvedScope, { kind: "user" }>;
      objectId: DurableHooksObjectId;
    }
  | {
      kind: "app";
      label: string;
      resolvedScope: Extract<BackofficeResolvedScope, { kind: "app" }>;
      objectId: DurableHooksObjectId;
    }
  | {
      kind: "project";
      label: string;
      resolvedScope: Extract<BackofficeResolvedScope, { kind: "project" }>;
      objectId: DurableHooksObjectId;
    };

export type DurableHooksObjectOption = {
  id: DurableHooksObjectId;
  binding: BackofficeObjectBindingName;
  label: string;
  to: string;
};

const objectScopeKindFromRouteScope = (scope: BackofficeRouteScope): BackofficeObjectScopeKind =>
  scope.kind === "system" ? "singleton" : scope.kind;

export const getDurableHooksObjectDefinition = (
  objectId: string | null | undefined,
): DurableHooksObjectDefinition | null =>
  DURABLE_HOOK_OBJECT_DEFINITIONS.find((definition) => definition.id === objectId) ?? null;

export const isDurableHooksObjectAllowedForScope = (
  objectId: DurableHooksObjectId,
  scope: BackofficeContextScope,
) => {
  const definition = getDurableHooksObjectDefinition(objectId);
  return Boolean(definition && isBackofficeObjectAvailableInContext(definition.binding, scope));
};

export const defaultDurableHooksObjectForScope = (
  scope: BackofficeContextScope,
): DurableHooksObjectId => {
  const definition = DURABLE_HOOK_OBJECT_DEFINITIONS.find(({ binding }) =>
    isBackofficeObjectAvailableInContext(binding, scope),
  );
  if (!definition) {
    throw new Error(`No durable hook object supports ${scope.kind} scope.`);
  }
  return definition.id;
};

export const durableHooksScopePath = (
  scope: BackofficeRouteScope,
  objectId: DurableHooksObjectId,
) => {
  const definition = getDurableHooksObjectDefinition(objectId);
  if (
    !definition ||
    !isBackofficeObjectScopeAllowed(definition.binding, objectScopeKindFromRouteScope(scope))
  ) {
    throw new Error(`Durable hook object ${objectId} does not support ${scope.kind} scope.`);
  }
  return `${internalsScopeBasePath(scope)}/durable-hooks/${objectId}`;
};

export const durableHooksSelectionPath = (selection: DurableHooksScopeSelection) =>
  durableHooksScopePath(
    backofficeRouteScopeFromResolvedScope(selection.resolvedScope),
    selection.objectId,
  );

/** Pairs a page's workspace with one of its durable objects, or null when it has no such object. */
export const resolveDurableHooksScopeSelection = ({
  scope,
  objectId,
}: {
  scope: BackofficeScopeSelection;
  objectId: string | undefined;
}): DurableHooksScopeSelection | null => {
  const objectDefinition = getDurableHooksObjectDefinition(objectId);
  if (
    !objectDefinition ||
    !isDurableHooksObjectAllowedForScope(
      objectDefinition.id,
      backofficeRuntimeScopeFromResolvedScope(scope),
    )
  ) {
    return null;
  }

  const { label, ...resolvedScope } = scope;
  switch (resolvedScope.kind) {
    case "system":
      return {
        kind: "singleton",
        label: "Singleton",
        resolvedScope,
        objectId: objectDefinition.id,
      };
    case "org":
      return { kind: "org", label, resolvedScope, objectId: objectDefinition.id };
    case "project":
      return { kind: "project", label, resolvedScope, objectId: objectDefinition.id };
    case "user":
      return { kind: "user", label, resolvedScope, objectId: objectDefinition.id };
    case "app":
      return { kind: "app", label, resolvedScope, objectId: objectDefinition.id };
    default:
      throw new Error("Unsupported Backoffice scope kind.", {
        cause: resolvedScope satisfies never,
      });
  }
};

export const createDurableHooksObjectOptions = (
  selection: DurableHooksScopeSelection,
): DurableHooksObjectOption[] => {
  const options: DurableHooksObjectOption[] = [];
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(selection.resolvedScope);
  for (const definition of DURABLE_HOOK_OBJECT_DEFINITIONS) {
    if (!isBackofficeObjectAvailableInContext(definition.binding, runtimeScope)) {
      continue;
    }

    options.push({
      id: definition.id,
      binding: definition.binding,
      label: definition.label,
      to: durableHooksScopePath(
        backofficeRouteScopeFromResolvedScope(selection.resolvedScope),
        definition.id,
      ),
    });
  }
  return options;
};

export const DURABLE_HOOKS_OBJECT_CONFIGURE_META: Partial<
  Record<
    DurableHooksObjectId,
    {
      path: (orgSlug: string) => string;
      label: string;
    }
  >
> = {
  api: {
    path: (orgSlug) => `/backoffice/integrations/org/${orgSlug}`,
    label: "Open integrations",
  },
  telegram: {
    path: (orgSlug) => `/backoffice/integrations/org/${orgSlug}/telegram/configuration`,
    label: "Configure Telegram",
  },
  otp: {
    path: (orgSlug) => `/backoffice/integrations/org/${orgSlug}/telegram/configuration`,
    label: "Open Telegram linking",
  },
  resend: {
    path: (orgSlug) => `/backoffice/integrations/org/${orgSlug}/resend/configuration`,
    label: "Configure Resend",
  },
  mcp: {
    path: (orgSlug) => `/backoffice/integrations/org/${orgSlug}`,
    label: "Open integrations",
  },
  github: {
    path: (orgSlug) => `/backoffice/integrations/org/${orgSlug}/github/configuration`,
    label: "Configure GitHub",
  },
  workflows: {
    path: (orgSlug) => `/backoffice/dashboard/org/${orgSlug}`,
    label: "Open dashboard",
  },
  automations: {
    path: (orgSlug) => `/backoffice/dashboard/org/${orgSlug}`,
    label: "Open dashboard",
  },
};

type ErrorLogger = (message?: unknown, ...optionalParams: unknown[]) => void;

export const getDurableHooksLoaderErrorMessage = ({
  selection,
  error,
  logError = console.error,
}: {
  selection: DurableHooksScopeSelection;
  error: unknown;
  logError?: ErrorLogger;
}) => {
  const objectLabel =
    getDurableHooksObjectDefinition(selection.objectId)?.label ?? selection.objectId;

  logError(`Failed to load ${objectLabel} durable hooks`, {
    scope: backofficeRuntimeScopeFromResolvedScope(selection.resolvedScope),
    objectId: selection.objectId,
    error,
  });

  if (selection.objectId === "upload") {
    return "Upload service unavailable";
  }

  return `Failed to load ${objectLabel} durable hooks.`;
};
