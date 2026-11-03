import type {
  OrchestrationExternal,
  OrchestrationExternalCall,
} from "@fragno-private/design-system/orchestration/orchestration-universe-model";

import {
  isTriviaToken,
  staticStringValue,
  tokenizeWorkflowSource,
  type SourceRange,
} from "@fragno-dev/workflow-visualizer-tokens";

import { visualizeWorkflowScript } from "@/fragno/automation/workflow-visualizations";
import type { IntegrationConnectionRecord } from "@/fragno/runtime-tools/families/integrations/integration-connections";
import {
  resolveWorkflowRuntimeToolCalls,
  type RuntimeToolWorkflowDescriptor,
} from "@/fragno/runtime-tools/workflow-catalog";

import { serviceIcon, workflowTargetId } from "./orchestration-graph";

/** A workflow script as a run kept it: its path and source. */
export type WorkflowProgram = { filename: string; code: string };

/** A workflow that calls an outside system, by the workflow's target ID in its scope's graph. */
export type WorkflowOutsideCall = Omit<OrchestrationExternalCall, "scopeId" | "externalId"> & {
  external: OrchestrationExternal;
};

/** The connections a scope's workflows execute actions on, as its replica records them. */
export type WorkflowConnections = readonly Pick<
  IntegrationConnectionRecord,
  "connectionId" | "service" | "displayName"
>[];

/** The systems outside Backoffice that workflows reach through runtime tools other than integrations. */
const OUTSIDE_SYSTEMS: readonly (OrchestrationExternal & {
  reachedBy: (tool: RuntimeToolWorkflowDescriptor) => boolean;
})[] = [
  { id: "web", label: "Web", icon: "globe", reachedBy: (tool) => tool.namespace === "web" },
  { id: "models", label: "Models", icon: "cpu", reachedBy: (tool) => tool.namespace === "models" },
  {
    id: "browser-run",
    label: "Browser Run",
    icon: "monitor",
    reachedBy: (tool) => tool.namespace === "cloudflare",
  },
];

const EXECUTE_INTEGRATION_ACTION = "integrations.execute";

/** Where integration actions go when the script works out their connection as it runs. */
const SOME_INTEGRATION: OrchestrationExternal = {
  id: "integrations",
  label: "Integrations",
  icon: "link",
};

/** The system a connection reaches, by its record in the calling scope, or by its address alone. */
function connectionSystem(
  connectionId: string,
  connections: WorkflowConnections,
): OrchestrationExternal {
  const connection = connections.find((candidate) => candidate.connectionId === connectionId);
  const [namespace, localId] = connectionId.includes("#")
    ? connectionId.split(/#(.*)/s, 2)
    : [connectionId, connectionId];
  return {
    id: `connection:${connectionId}`,
    label: connection?.displayName ?? localId,
    icon: (connection && serviceIcon(connection.service)) ?? serviceIcon(namespace) ?? "link",
  };
}

/**
 * The connection an `integrations.execute` call names: its first argument's `connectionId`, when
 * that is spelled out as a string. Null when the script works it out as it runs.
 */
export function executedConnectionId(code: string, call: SourceRange): string | null {
  const tokens = [...tokenizeWorkflowSource(code.slice(call.start.offset, call.end.offset))].filter(
    (token) => !isTriviaToken(token),
  );
  const open = tokens.findIndex(({ value }) => value === "(");
  if (tokens[open + 1]?.value !== "{") {
    return null;
  }
  // The properties of the argument are the tokens one bracket into it.
  let depth = 0;
  for (let index = open + 2; index < tokens.length && depth >= 0; index += 1) {
    const { value } = tokens[index];
    if (value === "(" || value === "{" || value === "[") {
      depth += 1;
    } else if (value === ")" || value === "}" || value === "]") {
      depth -= 1;
    } else if (
      depth === 0 &&
      (value === "connectionId" || staticStringValue(tokens[index]) === "connectionId") &&
      tokens[index + 1]?.value === ":" &&
      (tokens[index + 3]?.value === "," || tokens[index + 3]?.value === "}")
    ) {
      const connectionId = staticStringValue(tokens[index + 2]);
      return connectionId === undefined ? null : connectionId;
    }
  }
  return null;
}

/**
 * Which outside systems each workflow script calls in its steps, once per workflow and system. An
 * integration action reaches the connection it names, by the name `connections` give it, or every
 * such action whose connection the script works out as it runs reaches one shared system.
 */
export function workflowOutsideCalls(
  programs: readonly WorkflowProgram[],
  catalog: readonly RuntimeToolWorkflowDescriptor[],
  connections: WorkflowConnections,
): WorkflowOutsideCall[] {
  return programs.flatMap(({ filename, code }) => {
    const visualization = visualizeWorkflowScript(filename, code);
    const toolCalls = [
      ...resolveWorkflowRuntimeToolCalls({ visualization, catalog }).values(),
    ].flat();
    const systems = new Map<string, OrchestrationExternal>();
    for (const system of OUTSIDE_SYSTEMS) {
      if (toolCalls.some(({ tool }) => system.reachedBy(tool))) {
        systems.set(system.id, { id: system.id, label: system.label, icon: system.icon });
      }
    }
    for (const { tool, invocation } of toolCalls) {
      if (tool.qualifiedName === EXECUTE_INTEGRATION_ACTION) {
        const connectionId = executedConnectionId(code, invocation.source);
        const system = connectionId
          ? connectionSystem(connectionId, connections)
          : SOME_INTEGRATION;
        systems.set(system.id, system);
      }
    }
    return [...systems.values()].map((external) => ({
      workflowId: workflowTargetId(filename),
      external,
    }));
  });
}
