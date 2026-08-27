// workflow tools
type WorkflowCodemodeProvider = {
  /** Start a saved .workflow.js file by path. Inline defineWorkflow declarations start automatically. */
  createInstance(input: WorkflowCreateInstanceInput): Promise<WorkflowCreateInstanceOutput>;
  /** List durable saved-workflow instances. */
  listInstances(input: WorkflowListInstancesInput): Promise<WorkflowListInstancesOutput>;
  /** Get durable workflow instance details. */
  getInstance(input: WorkflowGetInstanceInput): Promise<WorkflowGetInstanceOutput>;
  /** Get durable workflow step, event, and emission history. */
  getHistory(input: WorkflowGetHistoryInput): Promise<WorkflowGetHistoryOutput>;
  /** Send an event to a waiting durable workflow instance. */
  sendEvent(input: WorkflowSendEventInput): Promise<WorkflowSendEventOutput>;
  /** Retry an errored instance's failed top-level step. */
  retryFailedStep(input: WorkflowRetryFailedStepInput): Promise<WorkflowRetryFailedStepOutput>;
};
declare const workflow: WorkflowCodemodeProvider;

type WorkflowCreateInstanceInput = {
  path: string;
  instanceId: string;
  payload?: {
    [key: string]: unknown;
  };
};
type WorkflowCreateInstanceOutput = {
  instanceId: string;
};
type WorkflowListInstancesInput = {
  status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  pageSize?: number;
  cursor?: string;
};
type WorkflowListInstancesOutput = {
  instances: {
    id: string;
    details: {
      status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
      error?: {
        name: string;
        message: string;
      };
      output?: unknown;
    };
    createdAt: string;
  }[];
  nextCursor?: string;
  hasNextPage: boolean;
};
type WorkflowGetInstanceInput = {
  instanceId: string;
};
type WorkflowGetInstanceOutput = {
  id: string;
  details: {
    status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
    error?: {
      name: string;
      message: string;
    };
    output?: unknown;
  };
  meta: {
    name: string;
    path: string;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    completedAt: string | null;
  };
};
type WorkflowGetHistoryInput = {
  instanceId: string;
};
type WorkflowGetHistoryOutput = {
  steps: unknown[];
  events: unknown[];
  emissions: unknown[];
};
type WorkflowSendEventInput = {
  instanceId: string;
  type: string;
  payload?: unknown;
};
type WorkflowSendEventOutput = {
  accepted: true;
};
type WorkflowRetryFailedStepInput = {
  instanceId: string;
  delayMs?: number;
};
type WorkflowRetryFailedStepOutput = {
  accepted: true;
  instance: {
    id: string;
    details: {
      status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
      error?: {
        name: string;
        message: string;
      };
      output?: unknown;
    };
  };
  retry: {
    stepKey: string;
    attempts: number;
    maxAttempts: number;
    scheduledAt: string;
  };
};
