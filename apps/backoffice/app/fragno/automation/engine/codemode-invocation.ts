import { z } from "zod";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import {
  backofficeContextScopesEqual,
  backofficeExecutionScopeRestriction,
} from "@/backoffice-runtime/context";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { backofficeContextScopeSchema } from "@/backoffice-runtime/context-schema";
import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import {
  knownBackofficePermissions,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";
import { piAgentCreationSchema } from "@/fragno/pi-manager/pi-agent-contract";

import {
  automationActorsSchema,
  automationDelegatedActorSchema,
  automationEntityRefsEqual,
  type AutomationActors,
} from "../actors";
import type { AutomationEvent, AutomationEventPayload } from "../contracts";
import { automationEventSchema } from "../events";

export const CODEMODE_WORKFLOW = "codemode-script";

export const CODEMODE_CAPABILITY_ACTOR = {
  scope: "internal",
  type: "capability",
  id: CODEMODE_WORKFLOW,
  role: "delegate",
} as const satisfies AutomationActors["delegation"][number];

const dependencyMapSchema = z.record(z.string().trim().min(1), z.string().trim().min(1));

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
  program: {
    code: string;
    dependencies: NpmDependencyMap;
    workflowName: string;
    filename: string;
  };
  trigger: CodemodeWorkflowTrigger<AutomationEventPayload>;
  execution: {
    scope: BackofficeExecutionContext["scope"];
    scopeRestriction: BackofficeExecutionContext["scope"] | null;
    actors: AutomationActors;
    billingOrganizationId: string | null;
    capabilityGrants: readonly CodemodeCapabilityGrant[];
  };
};

export const codemodeWorkflowParamsSchema: z.ZodType<CodemodeWorkflowParams> = z.looseObject({
  program: z.strictObject({
    code: z.string().min(1),
    dependencies: dependencyMapSchema,
    workflowName: z.string().trim().min(1),
    filename: z.string().trim().min(1),
  }),
  trigger: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("event"), event: automationEventSchema }),
    z.strictObject({
      type: z.literal("manual"),
      payload: z.record(z.string(), z.unknown()),
    }),
  ]),
  execution: z.strictObject({
    scope: backofficeContextScopeSchema,
    scopeRestriction: backofficeContextScopeSchema.nullable(),
    actors: automationActorsSchema,
    // Existing workflow snapshots predate billing inheritance and have no selected owner.
    billingOrganizationId: piAgentCreationSchema.shape.billingOrganizationId,
    capabilityGrants: z.array(codemodeCapabilityGrantSchema),
  }),
});

const workflowNameFromSource = (filename: string, code: string) => {
  const workflowNodes = visualizeWorkflowSource(filename, code).graph.nodes.filter(
    (node) => node.kind === "workflow",
  );
  if (workflowNodes.length !== 1) {
    throw new Error(
      `Codemode program '${filename}' must contain exactly one defineWorkflow(...) declaration.`,
    );
  }

  const workflowName = workflowNodes[0]?.name.trim();
  if (!workflowName) {
    throw new Error(`Codemode program '${filename}' must declare a static workflow name.`);
  }
  return workflowName;
};

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
  code,
  dependencies,
  filename,
  instanceId,
}: {
  code: string;
  dependencies?: NpmDependencyMap;
  filename: string;
  instanceId: string;
}): PreparedCodemodeWorkflowInstance {
  const workflowName = workflowNameFromSource(filename, code);

  return {
    workflowName: CODEMODE_WORKFLOW,
    remoteWorkflowName: workflowName,
    instanceId,
    program: {
      code,
      dependencies: dependencies ?? {},
      workflowName,
      filename,
    },
  };
}

export function createCodemodeWorkflowInstanceInput<TPayload extends AutomationEventPayload>({
  prepared,
  trigger,
  execution,
  billingOrganizationId,
  capabilityGrants = [],
}: {
  prepared: PreparedCodemodeWorkflowInstance;
  trigger: CodemodeWorkflowTrigger<TPayload>;
  execution: BackofficeExecutionContext;
  billingOrganizationId: string | null;
  capabilityGrants?: readonly CodemodeCapabilityGrant[];
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
        billingOrganizationId:
          execution.scope.kind === "org" || execution.scope.kind === "project"
            ? execution.scope.orgId
            : billingOrganizationId,
        capabilityGrants,
      },
    } satisfies CodemodeWorkflowParams,
  };
}
