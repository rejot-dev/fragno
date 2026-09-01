import { z } from "zod";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import { backofficeContextScopesEqual } from "@/backoffice-runtime/context";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { backofficeContextScopeSchema } from "@/backoffice-runtime/context-schema";
import type { NpmDependencyMap } from "@/backoffice-runtime/dynamic-workers/npm-dependencies";
import {
  backofficePermissionRequirementSchema,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";

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
  permissions: z.array(backofficePermissionRequirementSchema),
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
    actors: AutomationActors;
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
    actors: automationActorsSchema,
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
  capabilityGrants = [],
}: {
  prepared: PreparedCodemodeWorkflowInstance;
  trigger: CodemodeWorkflowTrigger<TPayload>;
  execution: BackofficeExecutionContext;
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
        actors: execution.actors,
        capabilityGrants,
      },
    } satisfies CodemodeWorkflowParams,
  };
}
