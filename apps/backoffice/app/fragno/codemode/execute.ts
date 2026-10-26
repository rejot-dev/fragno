import {
  type BackofficeContextScope,
  backofficeScopeProjectOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { CodemodeWireError } from "@fragno-dev/codemode/execution/codemode-error-contract";
import { codemodeScopedCallSchema } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import { resolveProvider, type ExecuteResult } from "@fragno-dev/codemode/runtime-api";
import { withBackofficeUiBuilder } from "@fragno-private/backoffice-ui/builder";
import type { z } from "zod";

import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import type { BackofficeRootOwnerResolver } from "@/backoffice-runtime/resolved-scope";
import { BackofficeToolUnavailableError } from "@/fragno/runtime-tools/runtime-errors";
import {
  createBackofficeCodemodeProviders,
  executeBackofficeRuntimeTool,
} from "@/fragno/runtime-tools/runtime-tools";
import type {
  BackofficeRuntimeToolFamily,
  BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";
import type { CoreBackofficeToolContext } from "@/fragno/runtime-tools/tool-families";

import type { CodemodeRunToolCall } from "./codemode-fragment";
import {
  codemodeProviderManifest,
  executeCodemodeInObject,
  type CodemodeRunner,
  type CodemodeRunTools,
} from "./codemode-object-execute";
import { createCodemodeToolCallLog, type CodemodeToolCallLog } from "./codemode-tool-call-observer";
import { readSavedModuleImports } from "./saved-module-imports";

export type RunBackofficeCodemodeInput = {
  code: string;
  dependencies?: NpmDependencyMap;
  codemode: CodemodeRunner;
  timeout?: number;
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: CoreBackofficeToolContext;
  /** Sees the run's calls as each starts and settles, such as to show them while the run continues. */
  onToolCalls?: (calls: readonly CodemodeRunToolCall[]) => void;
};

export type BackofficeCodemodeProvidersInput = {
  families: readonly BackofficeRuntimeToolFamily[];
  toolContext: CoreBackofficeToolContext;
  toolCallLog: CodemodeToolCallLog | null;
};

export type BackofficeCodemodeWorkflowDefinition = {
  name: string;
  options?: unknown;
};

export type BackofficeCodemodeExecuteResult = ExecuteResult & {
  /** Leads to the run's retained record: its logs and tool calls. */
  runId: string;
  errorDetails: CodemodeWireError | null;
  /** Oldest first, as the run's guest made them. */
  toolCalls: readonly CodemodeRunToolCall[];
  workflowDefinition?: BackofficeCodemodeWorkflowDefinition;
  /** Saved modules the code imported; a workflow it defines pins these when scheduled. */
  modules: Record<string, string>;
};

type ScopedCodemodeCallInput = z.infer<typeof codemodeScopedCallSchema>;

const callScopedTool = async (
  input: ScopedCodemodeCallInput,
  scopedContext: BackofficeToolContext,
  families: readonly BackofficeRuntimeToolFamily[],
) => {
  const family = families.find((candidate) =>
    candidate.tools.some(
      (tool) => tool.namespace === input.namespace && tool.name === input.toolName,
    ),
  );
  const tool = family?.tools.find(
    (candidate) => candidate.namespace === input.namespace && candidate.name === input.toolName,
  );
  if (!tool) {
    throw new Error(`Unknown scoped tool: ${input.namespace}.${input.toolName}`);
  }
  if (family?.isAvailable && !family.isAvailable(scopedContext)) {
    throw new BackofficeToolUnavailableError(
      `${tool.namespace}.${tool.name}`,
      scopedContext.execution.scope,
      tool.description,
    );
  }
  return await executeBackofficeRuntimeTool(tool, input.args[0], scopedContext);
};

async function codemodeCallScope(
  requested: ScopedCodemodeCallInput["scope"],
  current: BackofficeContextScope,
  resolveRootOwner: BackofficeRootOwnerResolver,
): Promise<BackofficeContextScope> {
  switch (requested.kind) {
    case "current":
      return current;
    // A project handle names only the project, beside the current workspace that owns it.
    case "project": {
      const owner = backofficeScopeProjectOwner(current);
      if (!owner) {
        throw new Error("Project scoped codemode handles require a workspace that owns projects.");
      }
      return { kind: "project", owner, projectId: requested.projectId };
    }
    // Guests name organizations and users by ID; Auth knows where their objects are kept.
    case "org":
    case "user": {
      const owner = await resolveRootOwner(requested);
      if (!owner) {
        throw new Error(
          requested.kind === "org"
            ? `Organization '${requested.orgId}' does not exist.`
            : `User '${requested.userId}' does not exist.`,
        );
      }
      return owner;
    }
    default:
      throw new Error("Unsupported codemode scope kind.", { cause: requested satisfies never });
  }
}

/**
 * A run calls through the same handles again and again, and where an owner's objects are kept never
 * changes, so each owner is resolved once per run.
 */
function resolveRootOwnersOnce(resolve: BackofficeRootOwnerResolver): BackofficeRootOwnerResolver {
  const owners = new Map<string, ReturnType<BackofficeRootOwnerResolver>>();
  return (owner) => {
    const key = owner.kind === "org" ? `org:${owner.orgId}` : `user:${owner.userId}`;
    const known = owners.get(key);
    if (known) {
      return known;
    }
    const resolved = resolve(owner);
    owners.set(key, resolved);
    return resolved;
  };
}

const createBackofficeScopedCodemodeProvider = ({
  families,
  context,
}: {
  families: readonly BackofficeRuntimeToolFamily[];
  context: BackofficeToolContext;
}) => {
  const resolveRootOwner = resolveRootOwnersOnce(context.resolveRootOwner);
  return {
    name: "__context",
    fns: {
      getCurrentScope: async () => context.execution.scope,
      callScoped: async (rawInput: unknown) => {
        const input = codemodeScopedCallSchema.parse(rawInput);
        const scope = await codemodeCallScope(
          input.scope,
          context.execution.scope,
          resolveRootOwner,
        );
        return await callScopedTool(input, context.createScopedContext(scope), families);
      },
    },
  };
};

export function createBackofficeCodemodeRunTools({
  families,
  toolContext,
  toolCallLog,
}: BackofficeCodemodeProvidersInput): CodemodeRunTools {
  return {
    providers: [
      ...createBackofficeCodemodeProviders({ families, context: toolContext }),
      createBackofficeScopedCodemodeProvider({ families, context: toolContext }),
    ].map((provider) => resolveProvider(provider)),
    redactedResults: families.flatMap((family) =>
      family.tools
        .filter((tool) => tool.resultLogging === "redacted")
        .map((tool) => `${tool.namespace}.${tool.name}`),
    ),
    toolCallLog,
  };
}

export const runBackofficeCodemode = async ({
  code,
  dependencies,
  codemode,
  timeout,
  families,
  toolContext,
  onToolCalls,
}: RunBackofficeCodemodeInput): Promise<BackofficeCodemodeExecuteResult> => {
  const toolCallLog = createCodemodeToolCallLog(onToolCalls ?? null);

  const state = toolContext.runtimes.state;
  // Without a filesystem, saved-module imports stay unresolved and fail when the code runs.
  const { modules } = state
    ? await readSavedModuleImports({
        readFile: (path) => state.readFile(path),
        program: { kind: "inline", code },
      })
    : { modules: {} };
  const tools = createBackofficeCodemodeRunTools({ families, toolContext, toolCallLog });
  const { runId, completion } = await executeCodemodeInObject(
    codemode,
    {
      kind: "immediate",
      code: withBackofficeUiBuilder(code),
      modules,
      dependencies: dependencies ?? {},
      providers: codemodeProviderManifest(tools.providers),
      timeoutMs: timeout ?? 30_000,
    },
    { kind: "inline" },
    tools,
    null,
  );
  if (completion.status === "failed") {
    return {
      runId,
      result: undefined,
      error: completion.error.message,
      errorDetails: completion.error,
      logs: completion.logs,
      toolCalls: toolCallLog.calls,
      modules,
    };
  }
  return {
    runId,
    result: completion.value,
    errorDetails: null,
    logs: completion.logs,
    ...(completion.workflowDefinition ? { workflowDefinition: completion.workflowDefinition } : {}),
    toolCalls: toolCallLog.calls,
    modules,
  };
};
