// Workflow instances: start saved workflows, check status and history, show a run to the user, send events, retry steps, terminate runs. Read to run or follow a workflow.
type WorkflowCodemodeProvider = {
  /**
   * Start a saved .workflow.js file by path. Inline defineWorkflow declarations start automatically.
   * Requires `workflow.modify`.
   */
  createInstance(input: WorkflowCreateInstanceInput): Promise<WorkflowCreateInstanceOutput>;
  /**
   * List durable saved-workflow instances.
   * Requires `workflow.read`.
   */
  listInstances(input: WorkflowListInstancesInput): Promise<WorkflowListInstancesOutput>;
  /**
   * Get durable workflow instance details. waitingFor lists the event types it waits for, which sendEvent delivers; an event already sent and not yet taken is not listed again.
   * Requires `workflow.read`.
   */
  getInstance(input: WorkflowGetInstanceInput): Promise<WorkflowGetInstanceOutput>;
  /**
   * Show a run of a saved workflow in this scope as a card in your reply: its steps, every interface they return, such as a form it waits on, and its output, live, as an inline workflow shows. Only from an agent's turn, for a run in its own scope.
   * Requires `workflow.read`.
   */
  showInstance(input: WorkflowShowInstanceInput): Promise<WorkflowShowInstanceOutput>;
  /**
   * Get durable workflow step, event, and emission history.
   * Requires `workflow.read`.
   */
  getHistory(input: WorkflowGetHistoryInput): Promise<WorkflowGetHistoryOutput>;
  /**
   * Send an event to a waiting durable workflow instance.
   * Requires `workflow.modify`.
   */
  sendEvent(input: WorkflowSendEventInput): Promise<WorkflowSendEventOutput>;
  /**
   * Retry an errored instance's failed top-level step.
   * Requires `workflow.modify`.
   */
  retryFailedStep(input: WorkflowRetryFailedStepInput): Promise<WorkflowRetryFailedStepOutput>;
  /**
   * Terminate a saved workflow's run that has not ended, such as one left waiting for an event that will never come. A terminated run cannot resume.
   * Requires `workflow.modify`.
   */
  terminateInstance(
    input: WorkflowTerminateInstanceInput,
  ): Promise<WorkflowTerminateInstanceOutput>;
};
declare const workflow: WorkflowCodemodeProvider;

type WorkflowCreateInstanceInput = {
  path: string;
  instanceId: string;
  payload?: {
    [key: string]: unknown;
  };
  /** Only from an agent's turn: notify you, the calling agent, with a workflows instance.completed event carrying the run's status, output, and error when it ends. Works for runs in other scopes too. */
  notifyWhenDone?: boolean;
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
  waitingFor: string[];
};
type WorkflowShowInstanceInput = {
  instanceId: string;
};
type WorkflowShowInstanceOutput = {
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
  waitingFor: string[];
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
type WorkflowTerminateInstanceInput = {
  instanceId: string;
};
type WorkflowTerminateInstanceOutput = {
  terminated: true;
};
