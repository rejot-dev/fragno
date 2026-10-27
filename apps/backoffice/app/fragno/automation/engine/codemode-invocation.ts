import {
  automationActorsSchema,
  automationDelegatedActorSchema,
  automationEntityRefsEqual,
  type AutomationActors,
} from "@fragno-dev/backoffice-api/v0/automation";
import {
  type AutomationEvent,
  type AutomationEventPayload,
  automationEventSchema,
} from "@fragno-dev/backoffice-api/v0/events";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { piAgentNameSchema } from "@fragno-dev/backoffice-api/v0/shared/pi-agent-name";
import {
  backofficeContextScopeSchema,
  backofficeContextScopesEqual,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { normalizeCode } from "@fragno-dev/codemode/runtime-api";
import { z } from "zod";

import { backofficeExecutionScopeRestriction } from "@/backoffice-runtime/context";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import { knownBackofficePermissions } from "@/backoffice-runtime/stored-permissions";
import { type WorkflowReplyTo, workflowReplyToSchema } from "@/fragno/automation/workflow-reply";
import type { CodemodeWorkflowProgram } from "@/fragno/codemode/workflow-program";

export const CODEMODE_WORKFLOW = "codemode-script";

export const CODEMODE_CAPABILITY_ACTOR = {
  scope: "internal",
  type: "capability",
  id: CODEMODE_WORKFLOW,
  role: "delegate",
} as const satisfies AutomationActors["delegation"][number];

export type CodemodeCapabilityGrant = {
  actor: AutomationActors["delegation"][number];
  permissions: readonly BackofficePermissionRequirement[];
};

const codemodeCapabilityGrantSchema: z.ZodType<CodemodeCapabilityGrant> = z.strictObject({
  actor: automationDelegatedActorSchema,
  // Workflow snapshots are replayed after permissions may have been removed from the kernel.
  permissions: z
    .array(z.strictObject({ namespace: z.string(), permission: z.string() }))
    .transform(knownBackofficePermissions),
});

export type CodemodeWorkflowTrigger<T extends AutomationEventPayload> =
  | { type: "event"; event: AutomationEvent }
  | { type: "manual"; payload: T };

export type CodemodeWorkflowParams = {
  program: CodemodeWorkflowProgram & { dependencies: NpmDependencyMap };
  trigger: CodemodeWorkflowTrigger<AutomationEventPayload>;
  execution: {
    scope: BackofficeExecutionContext["scope"];
    scopeRestriction: BackofficeExecutionContext["scope"] | null;
    actors: AutomationActors;
    capabilityGrants: readonly CodemodeCapabilityGrant[];
  };
  replyTo: WorkflowReplyTo | null;
};

const codemodeWorkflowProgramSchema = z.strictObject({
  filename: z.string().trim().min(1),
  modules: z.record(z.string(), z.string()),
  dependencies: z.record(z.string().trim().min(1), z.string().trim().min(1)),
  workflowName: z.string().trim().min(1),
});

/**
 * The guest once evaluated a program expression and accepted a workflow definition, a bare
 * `(event, step)` run function, or a function returning either. The module keeps all three, and
 * calls a factory inside the run, where the guest called it, rather than at module evaluation.
 */
function legacyWorkflowModuleSource(code: string, workflowName: string) {
  const name = JSON.stringify(workflowName);
  return `const program = (
${normalizeCode(code.trim().replace(/;*$/u, ""))}
);
export default typeof program !== "function"
  ? program
  : program.length >= 2
    ? defineWorkflow({ name: ${name} }, program)
    : defineWorkflow({ name: ${name} }, async (event, step) => {
        const value = await program();
        return await (typeof value === "function" ? value : value.run)(event, step);
      });
`;
}

/** Workflow snapshots from before workflow modules store their program as one expression. */
const legacyCodemodeWorkflowProgramSchema = z
  .strictObject({
    code: z.string().min(1),
    // The oldest snapshots predate pinned imports and import nothing.
    modules: z.record(z.string(), z.string()).default({}),
    dependencies: z.record(z.string().trim().min(1), z.string().trim().min(1)),
    workflowName: z.string().trim().min(1),
    filename: z.string().trim().min(1),
  })
  .transform(({ code, modules, filename, ...program }) => {
    // Marketplace installation programs were named by a package-relative path.
    const entry = filename.startsWith("/") ? filename : `/${filename}`;
    return {
      ...program,
      filename: entry,
      modules: { ...modules, [entry]: legacyWorkflowModuleSource(code, program.workflowName) },
    };
  });

/** Runs started before agent replies named a scope reply to an agent of their own scope. */
const legacyAgentReplyToSchema = z.strictObject({
  kind: z.literal("agent"),
  agentName: piAgentNameSchema,
});

export const codemodeWorkflowParamsSchema: z.ZodType<CodemodeWorkflowParams> = z
  .object({
    program: z.union([codemodeWorkflowProgramSchema, legacyCodemodeWorkflowProgramSchema]),
    trigger: z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("event"), event: automationEventSchema }),
      z.strictObject({
        type: z.literal("manual"),
        payload: z.record(z.string(), z.unknown()),
      }),
    ]),
    // Persisted snapshots may still carry the removed billing selection; ownership now decides.
    execution: z.object({
      scope: backofficeContextScopeSchema,
      scopeRestriction: backofficeContextScopeSchema.nullable(),
      actors: automationActorsSchema,
      capabilityGrants: z.array(codemodeCapabilityGrantSchema),
    }),
    // Existing workflow snapshots predate replies and report to no one.
    replyTo: z.union([workflowReplyToSchema, legacyAgentReplyToSchema]).nullable().default(null),
  })
  .transform(({ replyTo, ...params }) => ({
    ...params,
    replyTo:
      replyTo?.kind === "agent" && !("scope" in replyTo)
        ? { ...replyTo, scope: params.execution.scope }
        : replyTo,
  }));

export const assertCodemodeCapabilityGrantsBelongToExecution = ({
  execution,
  capabilityGrants,
}: {
  execution: BackofficeExecutionContext;
  capabilityGrants: readonly CodemodeCapabilityGrant[];
}) => {
  for (const grant of capabilityGrants) {
    const actorBelongsToExecution = execution.actors.delegation.some((actor) =>
      automationEntityRefsEqual(actor, grant.actor),
    );
    if (!actorBelongsToExecution) {
      throw new Error(
        `Codemode capability grant actor '${grant.actor.type}:${grant.actor.id}' is not part of the execution delegation chain.`,
      );
    }
  }
};

export type PreparedCodemodeWorkflowInstance = {
  workflowName: typeof CODEMODE_WORKFLOW;
  remoteWorkflowName: string;
  instanceId: string;
  program: CodemodeWorkflowParams["program"];
};

export function prepareCodemodeWorkflowInstance({
  program,
  dependencies,
  instanceId,
}: {
  program: CodemodeWorkflowProgram;
  dependencies?: NpmDependencyMap;
  instanceId: string;
}): PreparedCodemodeWorkflowInstance {
  return {
    workflowName: CODEMODE_WORKFLOW,
    remoteWorkflowName: program.workflowName,
    instanceId,
    program: { ...program, dependencies: dependencies ?? {} },
  };
}

export function createCodemodeWorkflowInstanceInput<TPayload extends AutomationEventPayload>({
  prepared,
  trigger,
  execution,
  capabilityGrants = [],
  replyTo,
}: {
  prepared: PreparedCodemodeWorkflowInstance;
  trigger: CodemodeWorkflowTrigger<TPayload>;
  execution: BackofficeExecutionContext;
  capabilityGrants?: readonly CodemodeCapabilityGrant[];
  replyTo: WorkflowReplyTo | null;
}) {
  if (
    trigger.type === "event" &&
    !backofficeContextScopesEqual(trigger.event.scope, execution.scope)
  ) {
    throw new Error("Codemode event and execution scopes must match.");
  }
  assertCodemodeCapabilityGrantsBelongToExecution({ execution, capabilityGrants });

  return {
    workflowName: prepared.workflowName,
    remoteWorkflowName: prepared.remoteWorkflowName,
    instanceId: prepared.instanceId,
    params: {
      program: prepared.program,
      trigger,
      execution: {
        scope: execution.scope,
        scopeRestriction: backofficeExecutionScopeRestriction(execution),
        actors: execution.actors,
        capabilityGrants,
      },
      replyTo,
    } satisfies CodemodeWorkflowParams,
  };
}
