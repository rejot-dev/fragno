// pi tools
type PiCodemodeProvider = {
  /** Create a new Pi session. */
  createSession(input: PiCreateSessionInput): Promise<PiCreateSessionOutput>;
  /** Retrieve a Pi session by id. */
  getSession(input: PiGetSessionInput): Promise<PiGetSessionOutput>;
  /** List Pi sessions ordered by creation time. */
  listSessions(input: PiListSessionsInput): Promise<PiListSessionsOutput>;
  /** Send one prompt command through a Pi active session and return the settled result. */
  runTurn(input: PiRunTurnInput): Promise<PiRunTurnOutput>;
};
declare const pi: PiCodemodeProvider;

type PiCreateSessionInput = {
  billingOrganizationId?: string;
  model?: {
    provider: "openai" | "anthropic" | "gemini";
    name: string;
  };
  name?: string;
  systemMessage?: string;
  metadata?: {
    [key: string]: unknown;
  };
  tags?: string[];
  steeringMode?: "all" | "one-at-a-time";
};
type PiCreateSessionOutput = {
  id: string;
  name: string | null;
  status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  metadata: {
    [key: string]: unknown;
  } | null;
  /** ISO 8601 datetime string. */
  createdAt: string;
  /** ISO 8601 datetime string. */
  updatedAt: string;
  tags?: string[];
  steeringMode?: "all" | "one-at-a-time";
};
type PiGetSessionInput = {
  sessionId: string;
  events?: boolean;
  trace?: boolean;
  turns?: boolean;
};
type PiGetSessionOutput = {
  id: string;
  name: string | null;
  status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  metadata: {
    [key: string]: unknown;
  } | null;
  /** ISO 8601 datetime string. */
  createdAt: string;
  /** ISO 8601 datetime string. */
  updatedAt: string;
  workflow: {
    status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
    error?: {
      name: string;
      message: string;
    };
    output?: unknown;
  };
  agent: {
    state: {
      messages: unknown[];
      errorMessage?: string;
    };
  };
  tags?: string[];
  steeringMode?: "all" | "one-at-a-time";
};
type PiListSessionsInput = {
  limit?: number;
};
type PiListSessionsOutput = {
  id: string;
  name: string | null;
  status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  metadata: {
    [key: string]: unknown;
  } | null;
  /** ISO 8601 datetime string. */
  createdAt: string;
  /** ISO 8601 datetime string. */
  updatedAt: string;
  tags?: string[];
  steeringMode?: "all" | "one-at-a-time";
}[];
type PiRunTurnInput = {
  sessionId: string;
  text: string;
};
type PiRunTurnOutput = {
  id: string;
  name: string | null;
  status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  metadata: {
    [key: string]: unknown;
  } | null;
  /** ISO 8601 datetime string. */
  createdAt: string;
  /** ISO 8601 datetime string. */
  updatedAt: string;
  workflow: {
    status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
    error?: {
      name: string;
      message: string;
    };
    output?: unknown;
  };
  agent: {
    state: {
      messages: unknown[];
      errorMessage?: string;
    };
  };
  tags?: string[];
  steeringMode?: "all" | "one-at-a-time";
  assistantText: string;
  commandStatus: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  stream: unknown[];
  terminalState: {
    messages: unknown[];
    errorMessage?: string;
  };
};
