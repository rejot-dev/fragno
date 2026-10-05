import { RpcTarget } from "capnweb";

import { CODEMODE_LIMITS } from "../codemode-limits";
import type { CodemodeToolResult } from "../execution/codemode-activation-contract";
import { encodeCodemodeError } from "../execution/codemode-errors";
import { sanitizeToolName, type ResolvedProvider } from "../runtime-api";

const RESERVED_PROVIDER_NAMES = new Set([
  "context",
  "__createScopedContextHandle",
  "__rpcTargets",
  "__dispatchers",
  "__logs",
  "__logBytes",
  "__captureLog",
  "__codemodeCallbackFailure",
  "__throwCodemodeProviderError",
  "__FRAGNO_CODEMODE_WORKFLOW_TAG",
  "defineWorkflow",
  "__isFragnoCodemodeWorkflowDefinition",
  "RpcTarget",
  "WorkerEntrypoint",
  "AsyncLocalStorage",
  "logs",
  "logBytes",
  "captureLog",
  "workflowProgram",
  "suspensionKey",
  "isSuspension",
  "unwrap",
  "unsupported",
  "createRemoteWorkflowStep",
  "RemoteWorkflowEntrypoint",
]);

const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function validateProviderNames(providers: readonly ResolvedProvider[]): string | undefined {
  const seenNames = new Set<string>();
  for (const provider of providers) {
    if (RESERVED_PROVIDER_NAMES.has(provider.name)) {
      return `Provider name "${provider.name}" is reserved`;
    }
    if (!VALID_IDENTIFIER.test(provider.name)) {
      return `Provider name "${provider.name}" is not a valid JavaScript identifier`;
    }
    if (seenNames.has(provider.name)) {
      return `Duplicate provider name "${provider.name}"`;
    }
    seenNames.add(provider.name);
  }
  return undefined;
}

/** Exposes only own, explicitly registered provider functions to the guest. */
export class ToolDispatcher extends RpcTarget {
  readonly #fns: Record<string, (...args: unknown[]) => unknown>;

  constructor(fns: Record<string, (...args: unknown[]) => unknown>) {
    super();
    this.#fns = fns;
  }

  async call(toolName: string, args: unknown[]): Promise<CodemodeToolResult> {
    try {
      if (typeof toolName !== "string") {
        throw new Error("CODEMODE_TOOL_NAME_MUST_BE_STRING");
      }
      if (!Object.hasOwn(this.#fns, toolName)) {
        throw new Error(`Unknown tool: ${toolName}`);
      }
      if (!Array.isArray(args) || args.length > CODEMODE_LIMITS.maxEntries) {
        throw new Error("CODEMODE_TOOL_ARGUMENTS_MUST_BE_ARRAY");
      }
      return { status: "ok", value: await this.#fns[toolName](...args) };
    } catch (error) {
      return { status: "error", error: encodeCodemodeError(error) };
    }
  }
}

/** Rejects conflicting guest names before exposing provider functions as Cloudflare RPC targets. */
export function createCodemodeDispatchers(
  providers: readonly ResolvedProvider[],
): { dispatchers: Record<string, ToolDispatcher> } | { error: string } {
  const providerNameError = validateProviderNames(providers);
  if (providerNameError) {
    return { error: providerNameError };
  }

  const dispatchers = new Map<string, ToolDispatcher>();

  for (const provider of providers) {
    const sanitizedFns: Record<string, (...args: unknown[]) => Promise<unknown>> =
      Object.create(null);
    const sanitizedNames = new Map<string, string>();

    for (const [name, fn] of Object.entries(provider.fns)) {
      const sanitizedName = sanitizeToolName(name);
      const existingName = sanitizedNames.get(sanitizedName);
      if (existingName && existingName !== name) {
        return {
          error:
            `Tool names "${existingName}" and "${name}" both sanitize to ` +
            `"${sanitizedName}" in provider "${provider.name}"`,
        };
      }
      sanitizedNames.set(sanitizedName, name);
      sanitizedFns[sanitizedName] = fn;
    }

    dispatchers.set(provider.name, new ToolDispatcher(sanitizedFns));
  }

  // Cloudflare RPC requires plain-object dictionaries; fromEntries also preserves __proto__ as data.
  return { dispatchers: Object.fromEntries(dispatchers) };
}
