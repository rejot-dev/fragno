import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type {
  AutomationsObject,
  BackofficeObjectHandle,
} from "@/backoffice-runtime/object-registry";
import {
  BACKOFFICE_REQUIRED_PERMISSION_HEADER,
  backofficePermissionRequirementSchema,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";

import type {
  AutomationWorkflowRuntime,
  InternalAutomationWorkflowRuntime,
  InternalWorkflowCreateInstanceArgs,
  WorkflowCreateInstanceArgs,
  WorkflowInstanceDetails,
  WorkflowSendEventArgs,
} from "../runtime-tools/families/automations-workflow";
import { CODEMODE_WORKFLOW } from "./engine/codemode-invocation";
import { createWorkflowsRouteCaller } from "./route-callers";

export type PrepareSavedWorkflowInstance = (
  input: WorkflowCreateInstanceArgs,
) => Promise<InternalWorkflowCreateInstanceArgs>;

export type RouteBackedAutomationWorkflowRuntime = AutomationWorkflowRuntime &
  InternalAutomationWorkflowRuntime;

type WorkflowBackendErrorResponse = {
  status: number;
  headers: Headers;
  error?: { code?: string; message?: string };
};

/** Stable workflow backend failure fields for runtime tools and durable Pi diagnostics. */
export class AutomationWorkflowRuntimeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requiredPermission: BackofficePermissionRequirement | null,
  ) {
    super(message);
    this.name = "AutomationWorkflowRuntimeRequestError";
  }

  static is(cause: unknown): cause is AutomationWorkflowRuntimeRequestError {
    return (
      cause instanceof Error &&
      cause.name === "AutomationWorkflowRuntimeRequestError" &&
      "status" in cause &&
      typeof cause.status === "number" &&
      "code" in cause &&
      typeof cause.code === "string" &&
      "requiredPermission" in cause
    );
  }
}

function requiredPermissionFromWorkflowResponse(
  response: WorkflowBackendErrorResponse,
): BackofficePermissionRequirement | null {
  const encodedPermission = response.headers.get(BACKOFFICE_REQUIRED_PERMISSION_HEADER);
  if (!encodedPermission) {
    return null;
  }

  try {
    const permission = backofficePermissionRequirementSchema.safeParse(
      JSON.parse(encodedPermission) as unknown,
    );
    return permission.success ? permission.data : null;
  } catch {
    return null;
  }
}

function backendError(response: WorkflowBackendErrorResponse) {
  const message = response.error?.message
    ? `Workflows backend returned ${response.status}: ${response.error.message}`
    : `Workflows backend returned ${response.status}`;
  return new AutomationWorkflowRuntimeRequestError(
    response.status,
    response.error?.code ?? "WORKFLOW_RUNTIME_REQUEST_FAILED",
    message,
    requiredPermissionFromWorkflowResponse(response),
  );
}

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
  object: BackofficeObjectHandle<AutomationsObject>;
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
  }: WorkflowSendEventArgs & { workflowName: string }) => {
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

  const retryFailedInternalStep = async ({
    workflowName,
    instanceId,
    delayMs,
  }: {
    workflowName: string;
    instanceId: string;
    delayMs?: number;
  }) => {
    const response = await callRoute(
      "POST",
      "/:workflowName/instances/:instanceId/retry-failed-step",
      {
        pathParams: { workflowName, instanceId },
        body: { delayMs },
      },
    );

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
    retryFailedInternalStep,
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
    retryFailedStep: async (input) =>
      await retryFailedInternalStep({ ...input, workflowName: CODEMODE_WORKFLOW }),
    sendEvent: async (input) =>
      await sendInternalEvent({ ...input, workflowName: CODEMODE_WORKFLOW }),
    getHistory: async (input) =>
      await getInternalHistory({ ...input, workflowName: CODEMODE_WORKFLOW }),
  };
};
// oxlint-enable typescript/no-unsafe-return
