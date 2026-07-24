import type {
  StepInvocation,
  WorkflowVisualizationSnapshot,
} from "@fragno-dev/workflow-visualizer-tokens";

import type { BackofficeRuntimeToolFamily } from "./runtime-tools";

export interface RuntimeToolWorkflowDescriptor {
  id: string;
  namespace: string;
  name: string;
  qualifiedName: string;
  summary: string;
  description?: string;
}

export type RuntimeToolWorkflowScope = "current" | "org" | "project" | "user";
type RuntimeToolScopedProvider = Exclude<RuntimeToolWorkflowScope, "current">;

export interface ResolvedWorkflowRuntimeToolCall {
  invocation: StepInvocation;
  tool: RuntimeToolWorkflowDescriptor;
  scope: RuntimeToolWorkflowScope;
}

const SCOPED_PROVIDER_ROOTS = new Set<RuntimeToolScopedProvider>(["org", "project", "user"]);

/** Project executable runtime-tool definitions into serializable workflow metadata. */
export function createRuntimeToolWorkflowCatalog(
  families: readonly BackofficeRuntimeToolFamily[],
): RuntimeToolWorkflowDescriptor[] {
  const descriptors = families.flatMap((family) =>
    family.tools.map((tool) => ({
      id: tool.id,
      namespace: tool.namespace,
      name: tool.name,
      qualifiedName: runtimeToolQualifiedName(tool.namespace, tool.name),
      summary: tool.reference?.workflow?.summary ?? tool.description,
      ...(tool.reference?.workflow?.description
        ? { description: tool.reference.workflow.description }
        : {}),
    })),
  );

  const descriptorByQualifiedName = new Map<string, RuntimeToolWorkflowDescriptor>();
  for (const descriptor of descriptors) {
    const existing = descriptorByQualifiedName.get(descriptor.qualifiedName);
    if (existing) {
      throw new Error(
        `Runtime tools '${existing.id}' and '${descriptor.id}' share workflow reference '${descriptor.qualifiedName}'.`,
      );
    }
    descriptorByQualifiedName.set(descriptor.qualifiedName, descriptor);
  }

  return descriptors;
}

/** Link exact source-level call references to canonical Backoffice runtime-tool definitions. */
export function resolveWorkflowRuntimeToolCalls({
  visualization,
  catalog,
}: {
  visualization: WorkflowVisualizationSnapshot;
  catalog: readonly RuntimeToolWorkflowDescriptor[];
}): Map<string, ResolvedWorkflowRuntimeToolCall[]> {
  const toolsByQualifiedName = new Map(catalog.map((tool) => [tool.qualifiedName, tool]));
  const callsByStepId = new Map<string, ResolvedWorkflowRuntimeToolCall[]>();

  for (const node of visualization.graph.nodes) {
    if (node.kind !== "step") {
      continue;
    }

    const resolvedCalls = node.analysis.invocations.flatMap((invocation) => {
      const reference = runtimeToolReferenceForInvocation(invocation);
      if (!reference) {
        return [];
      }
      const tool = toolsByQualifiedName.get(reference.qualifiedName);
      return tool ? [{ invocation, tool, scope: reference.scope }] : [];
    });
    if (resolvedCalls.length > 0) {
      callsByStepId.set(node.id, resolvedCalls);
    }
  }

  return callsByStepId;
}

function runtimeToolReferenceForInvocation(
  invocation: StepInvocation,
): { qualifiedName: string; scope: RuntimeToolWorkflowScope } | undefined {
  const segments = [invocation.callee.root, ...invocation.callee.path];
  if (segments.length === 2) {
    const qualifiedName = qualifiedNameFromSegments(segments, 0);
    return qualifiedName ? { qualifiedName, scope: "current" } : undefined;
  }

  const scopedProvider = segments[0];
  if (segments.length === 3 && isRuntimeToolScopedProvider(scopedProvider)) {
    const qualifiedName = qualifiedNameFromSegments(segments, 1);
    return qualifiedName ? { qualifiedName, scope: scopedProvider } : undefined;
  }

  if (segments.length === 4 && segments[0] === "context" && segments[1] === "current") {
    const qualifiedName = qualifiedNameFromSegments(segments, 2);
    return qualifiedName ? { qualifiedName, scope: "current" } : undefined;
  }
  return undefined;
}

function isRuntimeToolScopedProvider(
  value: string | undefined,
): value is RuntimeToolScopedProvider {
  return value !== undefined && SCOPED_PROVIDER_ROOTS.has(value as RuntimeToolScopedProvider);
}

function qualifiedNameFromSegments(
  segments: readonly string[],
  namespaceIndex: number,
): string | undefined {
  const namespace = segments[namespaceIndex];
  const name = segments[namespaceIndex + 1];
  return namespace && name ? runtimeToolQualifiedName(namespace, name) : undefined;
}

function runtimeToolQualifiedName(namespace: string, name: string): string {
  return `${namespace}.${name}`;
}
