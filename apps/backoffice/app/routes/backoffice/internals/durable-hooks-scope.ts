import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type {
  BackofficeObjectBindingName,
  BackofficeObjectScopeKind,
} from "@/backoffice-runtime/object-registry";
import { isBackofficeObjectScopeAllowed } from "@/backoffice-runtime/object-registry";
import {
  backofficeResolvedScopeFromRuntimeScope,
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import type { BackofficeMeData } from "@/fragno/auth/auth-client";

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
  { id: "pi", binding: "AUTOMATIONS", label: "Pi" },
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
      kind: "project";
      label: string;
      resolvedScope: Extract<BackofficeResolvedScope, { kind: "project" }>;
      objectId: DurableHooksObjectId;
    };

export type DurableHooksProject = {
  id: string;
  orgId: string;
  label: string;
  slug: string | null;
};

export type DurableHooksScopeOption = {
  id: string;
  kind: DurableHooksScopeSelection["kind"];
  label: string;
  description: string;
  to: string;
};

export type DurableHooksObjectOption = {
  id: DurableHooksObjectId;
  binding: BackofficeObjectBindingName;
  label: string;
  to: string;
};

type Organization = Pick<
  BackofficeMeData["organizations"][number]["organization"],
  "id" | "name" | "slug"
>;

type User = Pick<BackofficeMeData["user"], "id" | "email">;

const objectScopeKindFromContextScope = (
  scope: BackofficeContextScope,
): BackofficeObjectScopeKind => (scope.kind === "system" ? "singleton" : scope.kind);

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
  return Boolean(
    definition &&
    isBackofficeObjectScopeAllowed(definition.binding, objectScopeKindFromContextScope(scope)),
  );
};

export const defaultDurableHooksObjectForScope = (
  scope: BackofficeContextScope,
): DurableHooksObjectId => {
  const definition = DURABLE_HOOK_OBJECT_DEFINITIONS.find(({ binding }) =>
    isBackofficeObjectScopeAllowed(binding, objectScopeKindFromContextScope(scope)),
  );
  if (!definition) {
    throw new Error(`No durable hook object supports ${scope.kind} scope.`);
  }
  return definition.id;
};

const compatibleObjectForScope = (
  preferredObjectId: DurableHooksObjectId,
  scope: BackofficeContextScope,
) =>
  isDurableHooksObjectAllowedForScope(preferredObjectId, scope)
    ? preferredObjectId
    : defaultDurableHooksObjectForScope(scope);

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

export const resolveDurableHooksScopeSelection = ({
  scope,
  objectId,
  organizations,
  projects,
  user,
}: {
  scope: BackofficeContextScope;
  objectId: string | undefined;
  organizations: Organization[];
  projects: DurableHooksProject[];
  user: User;
}): DurableHooksScopeSelection | null => {
  const objectDefinition = getDurableHooksObjectDefinition(objectId);
  if (!objectDefinition || !isDurableHooksObjectAllowedForScope(objectDefinition.id, scope)) {
    return null;
  }

  if (scope.kind === "system") {
    return {
      kind: "singleton",
      label: "Singleton",
      resolvedScope: { kind: "system" },
      objectId: objectDefinition.id,
    };
  }

  if (scope.kind === "user") {
    if (scope.userId !== user.id) {
      return null;
    }
    return {
      kind: "user",
      label: user.email ?? user.id,
      resolvedScope: { kind: "user", userId: scope.userId },
      objectId: objectDefinition.id,
    };
  }

  const organization = organizations.find((entry) => entry.id === scope.orgId);
  if (!organization) {
    return null;
  }

  if (scope.kind === "org") {
    return {
      kind: "org",
      label: organization.name ?? organization.id,
      resolvedScope: backofficeResolvedScopeFromRuntimeScope(scope, organization),
      objectId: objectDefinition.id,
    };
  }

  const project = projects.find(
    (entry) => entry.orgId === scope.orgId && entry.id === scope.projectId,
  );
  if (!project) {
    return null;
  }

  return {
    kind: "project",
    label: project.label,
    resolvedScope: backofficeResolvedScopeFromRuntimeScope(scope, organization),
    objectId: objectDefinition.id,
  };
};

export const createDurableHooksScopeOptions = ({
  organizations,
  projects,
  user,
  selection,
}: {
  organizations: Organization[];
  projects: DurableHooksProject[];
  user: User;
  selection: DurableHooksScopeSelection;
}): DurableHooksScopeOption[] => {
  const optionForScope = ({
    kind,
    label,
    description,
    resolvedScope,
  }: Omit<DurableHooksScopeOption, "id" | "to"> & {
    resolvedScope: BackofficeResolvedScope;
  }) => {
    const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
    return {
      id: backofficeContextScopeRoutePath(runtimeScope),
      kind,
      label,
      description,
      to: durableHooksScopePath(
        backofficeRouteScopeFromResolvedScope(resolvedScope),
        compatibleObjectForScope(selection.objectId, runtimeScope),
      ),
    };
  };

  return [
    optionForScope({
      kind: "singleton",
      label: "Singleton",
      description: "Global durable object scope",
      resolvedScope: { kind: "system" },
    }),
    ...organizations.map((organization) =>
      optionForScope({
        kind: "org",
        label: organization.name ?? organization.id,
        description: organization.slug
          ? `Organization · ${organization.slug}`
          : "Organization scope",
        resolvedScope: { kind: "org", organization },
      }),
    ),
    ...projects.flatMap((project) => {
      const organization = organizations.find(({ id }) => id === project.orgId);
      return organization
        ? [
            optionForScope({
              kind: "project",
              label: project.label,
              description: project.slug ? `Project · ${project.slug}` : "Project scope",
              resolvedScope: {
                kind: "project",
                organization,
                projectId: project.id,
              },
            }),
          ]
        : [];
    }),
    optionForScope({
      kind: "user",
      label: user.email ?? user.id,
      description: "Personal user scope",
      resolvedScope: { kind: "user", userId: user.id },
    }),
  ];
};

export const createDurableHooksObjectOptions = (
  selection: DurableHooksScopeSelection,
): DurableHooksObjectOption[] => {
  const options: DurableHooksObjectOption[] = [];
  const scopeKind = objectScopeKindFromContextScope(
    backofficeRuntimeScopeFromResolvedScope(selection.resolvedScope),
  );
  for (const definition of DURABLE_HOOK_OBJECT_DEFINITIONS) {
    if (!isBackofficeObjectScopeAllowed(definition.binding, scopeKind)) {
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
    path: (orgSlug) => `/backoffice/automations/org/${orgSlug}/api`,
    label: "Configure API",
  },
  telegram: {
    path: (orgSlug) => `/backoffice/automations/org/${orgSlug}/integrations/telegram/configuration`,
    label: "Configure Telegram",
  },
  otp: {
    path: (orgSlug) => `/backoffice/automations/org/${orgSlug}/integrations/telegram/configuration`,
    label: "Open Telegram linking",
  },
  resend: {
    path: (orgSlug) => `/backoffice/automations/org/${orgSlug}/integrations/resend/configuration`,
    label: "Configure Resend",
  },
  mcp: {
    path: (orgSlug) =>
      `/backoffice/automations/${backofficeRouteScopePath({ kind: "org", orgSlug })}/mcp`,
    label: "Configure MCP",
  },
  upload: {
    path: (orgSlug) => `/backoffice/connections/upload/${orgSlug}/configuration`,
    label: "Configure Upload",
  },
  github: {
    path: (orgSlug) => `/backoffice/automations/org/${orgSlug}/integrations/github/configuration`,
    label: "Configure GitHub",
  },
  pi: {
    path: (orgSlug) => `/backoffice/sessions/${orgSlug}/configuration`,
    label: "Configure Pi",
  },
  workflows: {
    path: (orgSlug) => `/backoffice/automations/org/${orgSlug}/dashboard`,
    label: "Open Automations runtime",
  },
  automations: {
    path: (orgSlug) => `/backoffice/automations/org/${orgSlug}/dashboard`,
    label: "Open Automations runtime",
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
