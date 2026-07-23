import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type {
  BackofficeObjectBindingName,
  BackofficeObjectScopeKind,
} from "@/backoffice-runtime/object-registry";
import { isBackofficeObjectScopeAllowed } from "@/backoffice-runtime/object-registry";
import { backofficeContextScopeFromSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import type { AuthMeData } from "@/fragno/auth/auth-client";

export const DURABLE_HOOK_OBJECT_DEFINITIONS = [
  { id: "api", binding: "API", label: "API" },
  { id: "auth", binding: "AUTH", label: "Auth" },
  { id: "automations", binding: "AUTOMATIONS", label: "Automations" },
  { id: "telegram", binding: "TELEGRAM", label: "Telegram" },
  { id: "otp", binding: "OTP", label: "OTP" },
  { id: "resend", binding: "RESEND", label: "Resend" },
  { id: "mcp", binding: "MCP", label: "MCP" },
  { id: "upload", binding: "UPLOAD", label: "Upload" },
  { id: "github", binding: "GITHUB", label: "GitHub" },
  { id: "pi", binding: "PI", label: "Pi" },
  { id: "pi-workflows", binding: "PI", label: "Pi · Workflows" },
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
      scopeId: "singletons";
      label: "Singleton";
      scope: { kind: "system" };
      objectId: DurableHooksObjectId;
    }
  | {
      kind: "org";
      scopeId: string;
      orgId: string;
      label: string;
      scope: { kind: "org"; orgId: string };
      objectId: DurableHooksObjectId;
    }
  | {
      kind: "user";
      scopeId: string;
      userId: string;
      label: string;
      scope: { kind: "user"; userId: string };
      objectId: DurableHooksObjectId;
    }
  | {
      kind: "project";
      scopeId: string;
      orgId: string;
      projectId: string;
      label: string;
      scope: { kind: "project"; orgId: string; projectId: string };
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

type Organisation = Pick<
  AuthMeData["organizations"][number]["organization"],
  "id" | "name" | "slug"
>;

type User = Pick<AuthMeData["user"], "id" | "email">;

const SINGLETON_SCOPE: BackofficeContextScope = { kind: "system" };

const objectScopeKindFromContextScope = (
  scope: BackofficeContextScope,
): BackofficeObjectScopeKind => (scope.kind === "system" ? "singleton" : scope.kind);

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

const durableHooksScopePathSegment = (scope: BackofficeContextScope) => {
  switch (scope.kind) {
    case "system":
      return "singletons";
    case "org":
      return encodeURIComponent(scope.orgId);
    case "user":
      return `user:${encodeURIComponent(scope.userId)}`;
    case "project":
      return `project:${encodeURIComponent(scope.orgId)}:${encodeURIComponent(scope.projectId)}`;
  }

  throw new Error("Unsupported durable hooks scope kind.");
};

export const durableHooksScopePath = (
  scope: BackofficeContextScope,
  objectId: DurableHooksObjectId,
) => {
  if (!isDurableHooksObjectAllowedForScope(objectId, scope)) {
    throw new Error(`Durable hook object ${objectId} does not support ${scope.kind} scope.`);
  }
  return `/backoffice/internals/durable-hooks/${durableHooksScopePathSegment(scope)}/${objectId}`;
};

export const durableHooksSelectionPath = (selection: DurableHooksScopeSelection) =>
  durableHooksScopePath(selection.scope, selection.objectId);

export const durableHooksContextScopeFromRouteId = (
  scopeId: string | undefined,
): BackofficeContextScope | null => {
  if (!scopeId) {
    return null;
  }
  if (scopeId === "singletons") {
    return SINGLETON_SCOPE;
  }
  if (scopeId.startsWith("user:") || scopeId.startsWith("project:")) {
    try {
      return backofficeContextScopeFromSinglePathSegment(scopeId);
    } catch {
      return null;
    }
  }
  return { kind: "org", orgId: scopeId };
};

export const resolveDurableHooksScopeSelection = ({
  scopeId,
  objectId,
  organisations,
  projects,
  user,
}: {
  scopeId: string | undefined;
  objectId: string | undefined;
  organisations: Organisation[];
  projects: DurableHooksProject[];
  user: User;
}): DurableHooksScopeSelection | null => {
  const scope = durableHooksContextScopeFromRouteId(scopeId);
  const objectDefinition = getDurableHooksObjectDefinition(objectId);
  if (
    !scope ||
    !objectDefinition ||
    !isDurableHooksObjectAllowedForScope(objectDefinition.id, scope)
  ) {
    return null;
  }

  if (scope.kind === "system") {
    return {
      kind: "singleton",
      scopeId: "singletons",
      label: "Singleton",
      scope,
      objectId: objectDefinition.id,
    };
  }

  if (scope.kind === "user") {
    if (scope.userId !== user.id) {
      return null;
    }
    return {
      kind: "user",
      scopeId: `user:${scope.userId}`,
      userId: scope.userId,
      label: user.email ?? user.id,
      scope,
      objectId: objectDefinition.id,
    };
  }

  const organisation = organisations.find((entry) => entry.id === scope.orgId);
  if (!organisation) {
    return null;
  }

  if (scope.kind === "org") {
    return {
      kind: "org",
      scopeId: organisation.id,
      orgId: organisation.id,
      label: organisation.name ?? organisation.id,
      scope,
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
    scopeId: `project:${scope.orgId}:${scope.projectId}`,
    orgId: scope.orgId,
    projectId: scope.projectId,
    label: project.label,
    scope,
    objectId: objectDefinition.id,
  };
};

export const createDurableHooksScopeOptions = ({
  organisations,
  projects,
  user,
  selection,
}: {
  organisations: Organisation[];
  projects: DurableHooksProject[];
  user: User;
  selection: DurableHooksScopeSelection;
}): DurableHooksScopeOption[] => {
  const optionForScope = ({
    id,
    kind,
    label,
    description,
    scope,
  }: Omit<DurableHooksScopeOption, "to"> & { scope: BackofficeContextScope }) => ({
    id,
    kind,
    label,
    description,
    to: durableHooksScopePath(scope, compatibleObjectForScope(selection.objectId, scope)),
  });

  return [
    optionForScope({
      id: "singleton:singletons",
      kind: "singleton",
      label: "Singleton",
      description: "Global durable object scope",
      scope: SINGLETON_SCOPE,
    }),
    ...organisations.map((organisation) =>
      optionForScope({
        id: `org:${organisation.id}`,
        kind: "org",
        label: organisation.name ?? organisation.id,
        description: organisation.slug
          ? `Organisation · ${organisation.slug}`
          : "Organisation scope",
        scope: { kind: "org", orgId: organisation.id },
      }),
    ),
    ...projects.map((project) =>
      optionForScope({
        id: `project:${project.orgId}:${project.id}`,
        kind: "project",
        label: project.label,
        description: project.slug ? `Project · ${project.slug}` : "Project scope",
        scope: { kind: "project", orgId: project.orgId, projectId: project.id },
      }),
    ),
    optionForScope({
      id: `user:${user.id}`,
      kind: "user",
      label: user.email ?? user.id,
      description: "Personal user scope",
      scope: { kind: "user", userId: user.id },
    }),
  ];
};

export const createDurableHooksObjectOptions = (
  selection: DurableHooksScopeSelection,
): DurableHooksObjectOption[] => {
  const options: DurableHooksObjectOption[] = [];
  const scopeKind = objectScopeKindFromContextScope(selection.scope);
  for (const definition of DURABLE_HOOK_OBJECT_DEFINITIONS) {
    if (!isBackofficeObjectScopeAllowed(definition.binding, scopeKind)) {
      continue;
    }

    options.push({
      id: definition.id,
      binding: definition.binding,
      label: definition.label,
      to: durableHooksScopePath(selection.scope, definition.id),
    });
  }
  return options;
};

export const DURABLE_HOOKS_OBJECT_CONFIGURE_META: Partial<
  Record<
    DurableHooksObjectId,
    {
      path: (orgId: string) => string;
      label: string;
    }
  >
> = {
  api: {
    path: () => "/backoffice/connections",
    label: "Configure API",
  },
  telegram: {
    path: (orgId) => `/backoffice/connections/telegram/${orgId}/configuration`,
    label: "Configure Telegram",
  },
  otp: {
    path: (orgId) => `/backoffice/connections/telegram/${orgId}/configuration`,
    label: "Open Telegram linking",
  },
  resend: {
    path: (orgId) => `/backoffice/connections/resend/${orgId}/configuration`,
    label: "Configure Resend",
  },
  mcp: {
    path: (orgId) => `/backoffice/connections/mcp/${orgId}/configuration`,
    label: "Configure MCP",
  },
  upload: {
    path: (orgId) => `/backoffice/connections/upload/${orgId}/configuration`,
    label: "Configure Upload",
  },
  github: {
    path: (orgId) => `/backoffice/connections/github/${orgId}/configuration`,
    label: "Configure GitHub",
  },
  pi: {
    path: (orgId) => `/backoffice/sessions/${orgId}/configuration`,
    label: "Configure Pi",
  },
  "pi-workflows": {
    path: (orgId) => `/backoffice/sessions/${orgId}/configuration`,
    label: "Configure Pi",
  },
  automations: {
    path: (orgId) => `/backoffice/automations/org/${orgId}/terminal`,
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
    scopeId: selection.scopeId,
    objectId: selection.objectId,
    error,
  });

  if (selection.objectId === "upload") {
    return "Upload service unavailable";
  }

  return `Failed to load ${objectLabel} durable hooks.`;
};
