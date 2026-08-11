import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { AutomationsObject } from "@/backoffice-runtime/object-registry";

import type {
  AutomationWorkflowRuntime,
  InternalAutomationWorkflowRuntime,
  InternalWorkflowCreateInstanceArgs,
  WorkflowCreateInstanceArgs,
  WorkflowInstanceDetails,
} from "../runtime-tools/families/automations-workflow";
import { CODEMODE_WORKFLOW } from "./engine/codemode-invocation";
import { createWorkflowsRouteCaller } from "./route-callers";

export type PrepareSavedWorkflowInstance = (
  input: WorkflowCreateInstanceArgs,
) => Promise<InternalWorkflowCreateInstanceArgs>;

export type RouteBackedAutomationWorkflowRuntime = AutomationWorkflowRuntime &
  InternalAutomationWorkflowRuntime;

const backendError = (response: { status: number; error?: { message?: string } }) =>
  new Error(
    response.error?.message
      ? `Workflows backend returned ${response.status}: ${response.error.message}`
      : `Workflows backend returned ${response.status}`,
  );

const savedWorkflowBackendInstanceMetaSchema = z.object({
  workflowName: z.literal(CODEMODE_WORKFLOW),
  params: z.object({
    program: z.object({
      workflowName: z.string().trim().min(1),
      filename: z.string().trim().min(1),
    }),
  }),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
  startedAt: z.union([z.string(), z.date()]).nullable(),
  completedAt: z.union([z.string(), z.date()]).nullable(),
  currentStep: z.unknown().optional(),
});

// Route outputs are validated by the Workflows fragment contract, whose generated caller defaults to `any`.
// oxlint-disable typescript/no-unsafe-return
export const createRouteBackedAutomationWorkflowRuntime = ({
  object,
  execution,
  prepareSavedWorkflowInstance,
}: {
  object: AutomationsObject;
  execution?: BackofficeExecutionContext;
  prepareSavedWorkflowInstance?: PrepareSavedWorkflowInstance;
}): RouteBackedAutomationWorkflowRuntime => {
  const callRoute = createWorkflowsRouteCaller({
    object,
    ...(execution ? { context: { execution, propagationContext: null } } : {}),
  });

  const createInternalInstance = async ({
    workflowName,
    remoteWorkflowName,
    instanceId,
    params,
  }: InternalWorkflowCreateInstanceArgs) => {
    const response = await callRoute("POST", "/:workflowName/instances", {
      pathParams: { workflowName },
      body: { id: instanceId, params, remoteWorkflowName },
    });

    if (response.type === "json") {
      return { workflowName, instanceId: response.data.id };
    }
    throw backendError(response);
  };

  const getInternalStatus = async ({
    workflowName,
    instanceId,
  }: {
    workflowName: string;
    instanceId: string;
  }) => {
    const response = await callRoute("GET", "/:workflowName/instances/:instanceId", {
      pathParams: { workflowName, instanceId },
    });

    if (response.type === "json") {
      return response.data.details;
    }
    throw backendError(response);
  };

  const sendInternalEvent = async ({
    workflowName,
    instanceId,
    type,
    payload,
  }: {
    workflowName: string;
    instanceId: string;
    type: string;
    payload?: unknown;
  }) => {
    const response = await callRoute("POST", "/:workflowName/instances/:instanceId/events", {
      pathParams: { workflowName, instanceId },
      body: { type, payload },
    });

    if (response.type === "json") {
      return response.data;
    }
    throw backendError(response);
  };

  const listInternalInstances = async ({
    workflowName,
    status,
    remoteWorkflowName,
    pageSize,
    cursor,
  }: {
    workflowName: string;
    status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
    remoteWorkflowName?: string;
    pageSize?: number;
    cursor?: string;
  }) => {
    const query: Record<string, string> = {};
    if (status) {
      query.status = status;
    }
    if (remoteWorkflowName) {
      query.remoteWorkflowName = remoteWorkflowName;
    }
    if (pageSize) {
      query.pageSize = String(pageSize);
    }
    if (cursor) {
      query.cursor = cursor;
    }

    const response = await callRoute("GET", "/:workflowName/instances", {
      pathParams: { workflowName },
      query,
    });

    if (response.type === "json") {
      return response.data;
    }
    throw backendError(response);
  };

  const getInternalInstance = async ({
    workflowName,
    instanceId,
  }: {
    workflowName: string;
    instanceId: string;
  }) => {
    const response = await callRoute("GET", "/:workflowName/instances/:instanceId", {
      pathParams: { workflowName, instanceId },
    });

    if (response.type === "json") {
      return response.data;
    }
    throw backendError(response);
  };

  const retryInternalInstance = async ({
    workflowName,
    instanceId,
    stepKey,
    delayMs,
    reason,
  }: {
    workflowName: string;
    instanceId: string;
    stepKey?: string;
    delayMs?: number;
    reason?: string;
  }) => {
    const response = await callRoute("POST", "/:workflowName/instances/:instanceId/retry", {
      pathParams: { workflowName, instanceId },
      body: { stepKey, delayMs, reason },
    });

    if (response.type === "json") {
      return response.data;
    }
    throw backendError(response);
  };

  const getInternalHistory = async ({
    workflowName,
    instanceId,
  }: {
    workflowName: string;
    instanceId: string;
  }) => {
    const response = await callRoute("GET", "/:workflowName/instances/:instanceId/history", {
      pathParams: { workflowName, instanceId },
    });

    if (response.type === "json") {
      return response.data;
    }
    throw backendError(response);
  };

  return {
    createInternalInstance,
    getInternalStatus,
    sendInternalEvent,
    listInternalWorkflows: async () => {
      const response = await callRoute("GET", "/");
      if (response.type === "json") {
        return response.data;
      }
      throw backendError(response);
    },
    listInternalInstances,
    getInternalInstance,
    retryInternalInstance,
    getInternalHistory,
    createInstance: async (input) => {
      if (!prepareSavedWorkflowInstance) {
        throw new Error(
          "Saved workflow source preparation is unavailable in this execution context.",
        );
      }
      const prepared = await prepareSavedWorkflowInstance(input);
      const created = await createInternalInstance(prepared);
      return { instanceId: created.instanceId };
    },
    listInstances: async (input) =>
      await listInternalInstances({ ...input, workflowName: CODEMODE_WORKFLOW }),
    getInstance: async ({ instanceId }) => {
      const instance = await getInternalInstance({ workflowName: CODEMODE_WORKFLOW, instanceId });
      const backendMeta = savedWorkflowBackendInstanceMetaSchema.parse(instance.meta);
      const details: WorkflowInstanceDetails = {
        id: instance.id,
        details: instance.details,
        meta: {
          name: backendMeta.params.program.workflowName,
          path: backendMeta.params.program.filename,
          createdAt: backendMeta.createdAt,
          updatedAt: backendMeta.updatedAt,
          startedAt: backendMeta.startedAt,
          completedAt: backendMeta.completedAt,
        },
      };
      return details;
    },
    retryInstance: async (input) =>
      await retryInternalInstance({ ...input, workflowName: CODEMODE_WORKFLOW }),
    sendEvent: async (input) =>
      await sendInternalEvent({ ...input, workflowName: CODEMODE_WORKFLOW }),
    getHistory: async (input) =>
      await getInternalHistory({ ...input, workflowName: CODEMODE_WORKFLOW }),
  };
};
// oxlint-enable typescript/no-unsafe-return
