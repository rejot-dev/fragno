import { z } from "zod";

/**
 * Every permission understood by the Backoffice authorization kernel.
 *
 * Each value is the canonical requirement used by actions, role grants, authority resolvers, and
 * resource policy. Adding an entry expands the authorization vocabulary but does not grant the new
 * permission to any role automatically.
 */
export const BACKOFFICE_PERMISSION = {
  admin: {
    organizationsManage: { namespace: "admin", permission: "organizations.manage" },
  },
  api: {
    connectionsCreate: { namespace: "api", permission: "connections.create" },
    connectionsDelete: { namespace: "api", permission: "connections.delete" },
    connectionsRead: { namespace: "api", permission: "connections.read" },
    requestsExecute: { namespace: "api", permission: "requests.execute" },
    webhooksManage: { namespace: "api", permission: "webhooks.manage" },
    webhooksRead: { namespace: "api", permission: "webhooks.read" },
  },
  capabilities: {
    read: { namespace: "capabilities", permission: "read" },
  },
  cloudflare: {
    browserRun: { namespace: "cloudflare", permission: "browserRun" },
  },
  connections: {
    manage: { namespace: "connections", permission: "manage" },
    read: { namespace: "connections", permission: "read" },
  },
  events: {
    emit: { namespace: "events", permission: "emit" },
    manage: { namespace: "events", permission: "manage" },
    read: { namespace: "events", permission: "read" },
    route: { namespace: "events", permission: "route" },
  },
  forms: {
    create: { namespace: "forms", permission: "create" },
    read: { namespace: "forms", permission: "read" },
    update: { namespace: "forms", permission: "update" },
  },
  hooks: {
    read: { namespace: "hooks", permission: "read" },
  },
  identity: {
    bind: { namespace: "identity", permission: "bind" },
    read: { namespace: "identity", permission: "read" },
    resolve: { namespace: "identity", permission: "resolve" },
    revoke: { namespace: "identity", permission: "revoke" },
  },
  internal: {
    manage: { namespace: "internal", permission: "manage" },
    read: { namespace: "internal", permission: "read" },
  },
  mcp: {
    serversCreate: { namespace: "mcp", permission: "servers.create" },
    serversDelete: { namespace: "mcp", permission: "servers.delete" },
    serversRead: { namespace: "mcp", permission: "servers.read" },
    toolsCall: { namespace: "mcp", permission: "tools.call" },
  },
  otp: {
    create: { namespace: "otp", permission: "create" },
  },
  pi: {
    modify: { namespace: "pi", permission: "modify" },
    read: { namespace: "pi", permission: "read" },
  },
  resend: {
    read: { namespace: "resend", permission: "read" },
    send: { namespace: "resend", permission: "send" },
  },
  reson8: {
    use: { namespace: "reson8", permission: "use" },
  },
  router: {
    modify: { namespace: "router", permission: "modify" },
    read: { namespace: "router", permission: "read" },
  },
  sandbox: {
    modify: { namespace: "sandbox", permission: "modify" },
    read: { namespace: "sandbox", permission: "read" },
  },
  store: {
    modify: { namespace: "store", permission: "modify" },
    read: { namespace: "store", permission: "read" },
  },
  telegram: {
    read: { namespace: "telegram", permission: "read" },
    send: { namespace: "telegram", permission: "send" },
  },
  upload: {
    modify: { namespace: "upload", permission: "modify" },
    read: { namespace: "upload", permission: "read" },
  },
  workflow: {
    executeCode: { namespace: "workflow", permission: "executeCode" },
    modify: { namespace: "workflow", permission: "modify" },
    read: { namespace: "workflow", permission: "read" },
  },
} as const;

type ValueOf<T> = T[keyof T];

export type BackofficePermissionNamespace = keyof typeof BACKOFFICE_PERMISSION;

/** A valid namespace-permission pair checked by the kernel. */
export type BackofficePermissionRequirement = ValueOf<{
  [TNamespace in BackofficePermissionNamespace]: ValueOf<
    (typeof BACKOFFICE_PERMISSION)[TNamespace]
  >;
}>;

export type BackofficePermission = BackofficePermissionRequirement["permission"];

const backofficePermissionNamespaces = Object.values(BACKOFFICE_PERMISSION) as readonly Readonly<
  Record<string, BackofficePermissionRequirement>
>[];

/** The complete finite permission set used by explicitly unrestricted authority roles. */
export const allBackofficePermissionRequirements = backofficePermissionNamespaces.flatMap(
  (namespacePermissions) => Object.values(namespacePermissions),
);

export const isBackofficePermissionRequirement = (input: {
  namespace: string;
  permission: string;
}): input is BackofficePermissionRequirement =>
  allBackofficePermissionRequirements.some(
    (requirement) =>
      requirement.namespace === input.namespace && requirement.permission === input.permission,
  );

type BackofficePermissionRequirementSchema = z.ZodType<BackofficePermissionRequirement>;

function backofficePermissionInputKey(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  return typeof candidate.namespace === "string" && typeof candidate.permission === "string"
    ? `${candidate.namespace}.${candidate.permission}`
    : null;
}

function createBackofficePermissionRequirementSchema(): BackofficePermissionRequirementSchema {
  const literalSchemas = allBackofficePermissionRequirements.map(
    (requirement) =>
      z.strictObject({
        namespace: z.literal(requirement.namespace),
        permission: z.literal(requirement.permission),
      }) as BackofficePermissionRequirementSchema,
  );
  const [first, second, ...remaining] = literalSchemas;
  if (!first || !second) {
    throw new Error("Backoffice authorization requires at least two canonical permissions.");
  }

  return z
    .union([first, second, ...remaining], {
      error: (issue) => {
        const key = backofficePermissionInputKey(issue.input);
        return key ? `Unknown Backoffice permission '${key}'.` : "Unknown Backoffice permission.";
      },
    })
    .meta({ id: "BackofficePermissionRequirement" }) as BackofficePermissionRequirementSchema;
}

/** Validates one canonical namespace-permission pair at an untrusted configuration boundary. */
export const backofficePermissionRequirementSchema = createBackofficePermissionRequirementSchema();
