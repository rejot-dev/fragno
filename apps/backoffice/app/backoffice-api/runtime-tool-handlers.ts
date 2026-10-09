import type {
  BackofficeApi,
  BackofficeApiImplementation,
  BackofficeApiPermission,
} from "@fragno-dev/backoffice-api/api";
import type { z } from "zod";

import {
  executeBackofficeRuntimeTool,
  type BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

/** The operation's family is not available to this execution, e.g. without a user principal. */
export class BackofficeApiOperationUnavailableError extends Error {
  constructor(operationId: string, scopeKind: string) {
    super(`'${operationId}' is not available to this credential in ${scopeKind} scope.`);
    this.name = "BackofficeApiOperationUnavailableError";
  }
}

/** System administration and internal plumbing stay behind Bash and Codemode. */
const API_DENIED_FAMILY_NAMESPACES: ReadonlySet<string> = new Set(["admin", "internal"]);

/**
 * Families kept out of the API for now. Cloudflare's Browser Run results are opaque `z.custom`
 * types in its fragment and need real schemas there first.
 */
const API_PENDING_FAMILY_NAMESPACES: ReadonlySet<string> = new Set(["cloudflare"]);

/**
 * Converts between an operation whose wire shape differs from its tool and that tool. `runTool`
 * validates, authorizes, and runs the tool, returning its parsed output; the router validates the
 * adapter's result against the operation's output schema.
 */
export type RuntimeToolAdapters<TApi extends BackofficeApi> = {
  [TId in keyof TApi["operations"]]?: (
    input: z.output<TApi["operations"][TId]["input"]>,
    runTool: (toolInput: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
};

function permissionList(permissions: readonly BackofficeApiPermission[]): string {
  return permissions
    .map(({ namespace, permission }) => `${namespace}.${permission}`)
    .sort()
    .join(", ");
}

/**
 * Serves every operation with the runtime tool of the same id, and requires every tool outside the
 * denied and pending families to be an operation.
 *
 * A tool must use its operation's schema instances, which makes the tool's types the contract's
 * types, unless an adapter converts between the operation's wire shape and the tool's. Either way it
 * must require exactly the operation's permissions, so the contract states what the kernel checks.
 */
export function createRuntimeToolHandlers<TApi extends BackofficeApi>(
  api: TApi,
  adapters: RuntimeToolAdapters<TApi>,
): BackofficeApiImplementation<TApi, BackofficeToolContext> {
  const toolsById = new Map(
    runtimeToolFamilies.flatMap((family) =>
      family.tools.map((tool) => [tool.id, { family, tool }] as const),
    ),
  );
  const handlers = Object.entries(api.operations).map(([operationId, operation]) => {
    const entry = toolsById.get(operationId);
    const adapt = adapters[operationId] as RuntimeToolAdapters<BackofficeApi>[string];
    if (
      !entry ||
      (!adapt &&
        (entry.tool.inputSchema !== operation.input ||
          entry.tool.outputSchema !== operation.output))
    ) {
      throw new Error(
        `API ${api.version} operation '${operationId}' has no runtime tool using its schemas.`,
      );
    }
    const { family, tool } = entry;
    if (permissionList(tool.requiredPermissions) !== permissionList(operation.permissions)) {
      throw new Error(
        `API ${api.version} operation '${operationId}' declares permissions [${permissionList(operation.permissions)}], but its runtime tool requires [${permissionList(tool.requiredPermissions)}].`,
      );
    }
    if (API_DENIED_FAMILY_NAMESPACES.has(family.namespace)) {
      throw new Error(
        `API ${api.version} operation '${operationId}' exposes the denied '${family.namespace}' tools.`,
      );
    }
    async function handle(input: unknown, context: BackofficeToolContext) {
      // Availability depends on the scope, the principal, and configured bindings.
      if (family.isAvailable && !family.isAvailable(context)) {
        throw new BackofficeApiOperationUnavailableError(operationId, context.execution.scope.kind);
      }
      const runTool = async (toolInput: unknown) =>
        await executeBackofficeRuntimeTool(tool, toolInput, context);
      return adapt ? await adapt(input, runTool) : await runTool(input);
    }
    return [operationId, handle] as const;
  });
  for (const family of runtimeToolFamilies) {
    if (
      API_DENIED_FAMILY_NAMESPACES.has(family.namespace) ||
      API_PENDING_FAMILY_NAMESPACES.has(family.namespace)
    ) {
      continue;
    }
    const missing = family.tools.filter(({ id }) => !Object.hasOwn(api.operations, id));
    if (missing.length > 0) {
      throw new Error(
        `API ${api.version} is missing operations for runtime tools: ${missing.map(({ id }) => id).join(", ")}.`,
      );
    }
  }
  // Schema identity, or an adapter's checked result, makes each handler match its operation.
  return Object.fromEntries(handlers) as BackofficeApiImplementation<TApi, BackofficeToolContext>;
}
