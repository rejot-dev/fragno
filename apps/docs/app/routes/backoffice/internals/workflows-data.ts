import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import type { createWorkflowsFragment, InstanceStatus } from "@fragno-dev/workflows";

import { getPiDurableObject } from "@/cloudflare/cloudflare-utils";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type WorkflowsFragment = ReturnType<typeof createWorkflowsFragment>;

type WorkflowRouteErrorResponse =
  | { type: "error"; status: number; error: { message: string } }
  | { type: "empty"; status: number }
  | { type: "jsonStream"; status: number };

type WorkflowRouteResponse<T> =
  | { type: "json"; status: number; data: T }
  | WorkflowRouteErrorResponse;

export const WORKFLOW_ORG_FRAGMENTS = ["pi"] as const;
export type WorkflowOrgFragment = (typeof WORKFLOW_ORG_FRAGMENTS)[number];
export type WorkflowInstanceStatus = InstanceStatus["status"];

export const WORKFLOW_FRAGMENT_META: Record<
  WorkflowOrgFragment,
  {
    label: string;
    configurePath: (orgId: string) => string;
  }
> = {
  pi: {
    label: "Pi",
    configurePath: (orgId) => `/backoffice/sessions/${orgId}/configuration`,
  },
};

export type WorkflowInstanceSummary = {
  fragment: WorkflowOrgFragment;
  workflowName: string;
  instanceId: string;
  status: WorkflowInstanceStatus;
  createdAt: string | Date | null;
  error?: { name: string; message: string };
};

export type WorkflowInstanceDetails = {
  id: string;
  details: {
    status: WorkflowInstanceStatus;
    error?: { name: string; message: string };
    output?: unknown;
  };
  meta: {
    workflowName: string;
    runNumber: number;
    params: unknown;
    createdAt: string | Date;
    updatedAt: string | Date;
    startedAt: string | Date | null;
    completedAt: string | Date | null;
    currentStep?: {
      stepKey: string;
      name: string;
      type: string;
      status: string;
      attempts: number;
      maxAttempts: number;
      timeoutMs: number | null;
      nextRetryAt: string | Date | null;
      wakeAt: string | Date | null;
      waitEventType: string | null;
      error?: { name: string; message: string };
    };
  };
  history: {
    runNumber: number;
    steps: Array<{
      id: string;
      runNumber: number;
      stepKey: string;
      name: string;
      type: string;
      status: string;
      attempts: number;
      maxAttempts: number;
      timeoutMs: number | null;
      nextRetryAt: string | Date | null;
      wakeAt: string | Date | null;
      waitEventType: string | null;
      result: unknown | null;
      error?: { name: string; message: string };
      createdAt: string | Date;
      updatedAt: string | Date;
    }>;
    events: Array<{
      id: string;
      runNumber: number;
      type: string;
      payload: unknown | null;
      createdAt: string | Date;
      deliveredAt: string | Date | null;
      consumedByStepKey: string | null;
    }>;
  };
};

type WorkflowListResponse = {
  workflows: Array<{ name: string }>;
};

type WorkflowInstancesResponse = {
  instances: Array<{
    id: string;
    details: InstanceStatus;
    createdAt?: string | Date | null;
  }>;
};

type WorkflowInstanceResponse = Pick<WorkflowInstanceDetails, "id" | "details" | "meta">;
type WorkflowHistoryResponse = WorkflowInstanceDetails["history"];

type WorkflowsRouteCaller = {
  (method: "GET", path: "/"): Promise<WorkflowRouteResponse<WorkflowListResponse>>;
  (
    method: "GET",
    path: "/:workflowName/instances",
    options: {
      pathParams: { workflowName: string };
      query: { pageSize: string };
    },
  ): Promise<WorkflowRouteResponse<WorkflowInstancesResponse>>;
  (
    method: "GET",
    path: "/:workflowName/instances/:instanceId",
    options: {
      pathParams: { workflowName: string; instanceId: string };
    },
  ): Promise<WorkflowRouteResponse<WorkflowInstanceResponse>>;
  (
    method: "GET",
    path: "/:workflowName/instances/:instanceId/history",
    options: {
      pathParams: { workflowName: string; instanceId: string };
    },
  ): Promise<WorkflowRouteResponse<WorkflowHistoryResponse>>;
};

export class WorkflowApiError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "WorkflowApiError";
    this.status = status;
  }
}

const toTimestamp = (value: string | Date | null | undefined) => {
  if (!value) {
    return 0;
  }
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

export const parsePageSize = (value: string | null, fallback = DEFAULT_PAGE_SIZE) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(MAX_PAGE_SIZE, parsed);
};

export const resolveWorkflowFragment = (value?: string | null): WorkflowOrgFragment | null => {
  if (value && WORKFLOW_ORG_FRAGMENTS.includes(value as WorkflowOrgFragment)) {
    return value as WorkflowOrgFragment;
  }
  return null;
};

const createWorkflowsRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  _fragment: WorkflowOrgFragment,
): WorkflowsRouteCaller => {
  const piDo = getPiDurableObject(context, orgId);
  return createRouteCaller<WorkflowsFragment>({
    baseUrl: request.url,
    mountRoute: "/api/workflows",
    baseHeaders: request.headers,
    fetch: piDo.fetch.bind(piDo),
  }) as unknown as WorkflowsRouteCaller;
};

const toApiError = (
  response: {
    type: string;
    status: number;
    error?: { message: string };
  },
  fallbackMessage: string,
) => {
  if (response.type === "error") {
    return new WorkflowApiError(response.error?.message ?? fallbackMessage, response.status);
  }
  return new WorkflowApiError(`${fallbackMessage} (${response.status})`, response.status);
};

export async function loadWorkflowInstanceSummaries(options: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
  fragment: WorkflowOrgFragment;
  pageSize?: number;
}): Promise<{
  workflows: string[];
  instances: WorkflowInstanceSummary[];
  warnings: string[];
}> {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE));
  const callRoute = createWorkflowsRouteCaller(
    options.request,
    options.context,
    options.orgId,
    options.fragment,
  );

  const workflowsResponse = await callRoute("GET", "/");
  if (workflowsResponse.type !== "json") {
    throw toApiError(workflowsResponse, "Failed to load workflows");
  }

  const workflows = workflowsResponse.data.workflows.map((entry: { name: string }) => entry.name);
  const instancePages = await Promise.all(
    workflows.map(async (workflowName: string) => {
      const response = await callRoute("GET", "/:workflowName/instances", {
        pathParams: { workflowName },
        query: { pageSize: String(pageSize) },
      });

      if (response.type !== "json") {
        return {
          workflowName,
          warning:
            response.type === "error"
              ? response.error.message
              : `Failed to load instances (${response.status}).`,
          items: [] as WorkflowInstanceSummary[],
        };
      }

      return {
        workflowName,
        warning: null,
        items: response.data.instances.map(
          (instance: {
            id: string;
            details: InstanceStatus;
            createdAt?: string | Date | null;
          }) => ({
            fragment: options.fragment,
            workflowName,
            instanceId: instance.id,
            status: instance.details.status,
            createdAt: instance.createdAt ?? null,
            error: instance.details.error,
          }),
        ),
      };
    }),
  );

  const warnings = instancePages
    .filter((entry) => entry.warning)
    .map((entry) => `${entry.workflowName}: ${entry.warning}`);

  const instances = instancePages
    .flatMap((entry) => entry.items)
    .sort((left, right) => toTimestamp(right.createdAt) - toTimestamp(left.createdAt));

  return { workflows, instances, warnings };
}

export async function loadWorkflowInstanceDetail(options: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  orgId: string;
  fragment: WorkflowOrgFragment;
  workflowName: string;
  instanceId: string;
}): Promise<WorkflowInstanceDetails> {
  const callRoute = createWorkflowsRouteCaller(
    options.request,
    options.context,
    options.orgId,
    options.fragment,
  );

  const [instanceResponse, historyResponse] = await Promise.all([
    callRoute("GET", "/:workflowName/instances/:instanceId", {
      pathParams: { workflowName: options.workflowName, instanceId: options.instanceId },
    }),
    callRoute("GET", "/:workflowName/instances/:instanceId/history", {
      pathParams: { workflowName: options.workflowName, instanceId: options.instanceId },
    }),
  ]);

  if (instanceResponse.type !== "json") {
    throw toApiError(instanceResponse, "Failed to load workflow instance");
  }

  if (historyResponse.type !== "json") {
    throw toApiError(historyResponse, "Failed to load workflow history");
  }

  return {
    id: instanceResponse.data.id,
    details: {
      status: instanceResponse.data.details.status,
      error: instanceResponse.data.details.error,
      output: instanceResponse.data.details.output,
    },
    meta: {
      workflowName: instanceResponse.data.meta.workflowName,
      runNumber: instanceResponse.data.meta.runNumber,
      params: instanceResponse.data.meta.params,
      createdAt: instanceResponse.data.meta.createdAt,
      updatedAt: instanceResponse.data.meta.updatedAt,
      startedAt: instanceResponse.data.meta.startedAt,
      completedAt: instanceResponse.data.meta.completedAt,
      currentStep: instanceResponse.data.meta.currentStep,
    },
    history: {
      runNumber: historyResponse.data.runNumber,
      steps: historyResponse.data.steps,
      events: historyResponse.data.events,
    },
  };
}
