export type WorkflowUsageDuration = string | number;

export type WorkflowUsageDslWaitStep = {
  type: "wait";
  duration: WorkflowUsageDuration;
  label?: string;
};

export type WorkflowUsageDslCalcStep = {
  type: "calc";
  expression: string;
  assign?: string;
  label?: string;
};

export type WorkflowUsageDslRandomStep = {
  type: "random";
  min?: number;
  max?: number;
  round?: "floor" | "ceil" | "round";
  assign?: string;
  label?: string;
};

export type WorkflowUsageDslInputStep = {
  type: "input";
  key: string;
  assign?: string;
  label?: string;
};

export type WorkflowUsageDslStep =
  | WorkflowUsageDslWaitStep
  | WorkflowUsageDslCalcStep
  | WorkflowUsageDslRandomStep
  | WorkflowUsageDslInputStep;

export type WorkflowUsageAgentDsl = {
  steps: WorkflowUsageDslStep[];
};

export type WorkflowUsageAgentDefinition = {
  label?: string;
  systemPrompt: string;
  metadata?: Record<string, unknown>;
  dsl?: WorkflowUsageAgentDsl;
};

export type WorkflowUsageDslState = Record<string, number>;

export type WorkflowUsageSessionCompletedPayload = {
  sessionId: string;
  agentName: string;
  turns: number;
  dslState: WorkflowUsageDslState;
};
