import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildHarness,
  createStreamFn,
  drainWorkflowRunner,
  mockModel,
  type DatabaseFragmentsTest,
} from "./test-utils";
import { SESSION_STATUSES } from "./constants";
import type { PiFragmentConfig } from "./types";
import { PI_WORKFLOW_NAME } from "./workflow";

const buildTestHarness = async () => {
  const streamFn = createStreamFn("assistant:messages");
  const config: PiFragmentConfig = {
    agents: {
      default: {
        name: "default",
        systemPrompt: "You are helpful.",
        model: mockModel,
        streamFn,
      },
    },
    tools: {},
  };

  return await buildHarness(config);
};

const createSession = async (fragments: DatabaseFragmentsTest["fragments"]) => {
  const response = await fragments.pi.callRoute("POST", "/sessions", {
    body: { agent: "default", name: "Message Session" },
  });

  if (response.type !== "json") {
    throw new Error(formatResponseError(response));
  }

  return response.data;
};

const createSessionForAgent = async (
  fragments: DatabaseFragmentsTest["fragments"],
  agent: string,
  name: string,
) => {
  const response = await fragments.pi.callRoute("POST", "/sessions", {
    body: { agent, name },
  });

  if (response.type !== "json") {
    throw new Error(formatResponseError(response));
  }

  return response.data;
};

const formatResponseError = (response: {
  type: string;
  error?: { code?: string; message?: string } | null;
}) => {
  const error = response.type === "error" ? response.error : undefined;
  return `Expected json response, got ${response.type}${
    error ? ` (${error.code ?? "UNKNOWN"}: ${error.message ?? "Unknown error"})` : ""
  }`;
};

const extractMessageText = (message: unknown) => {
  if (!message || typeof message !== "object") {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }
  const textBlock = content.find((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return (block as { type?: string }).type === "text";
  }) as { text?: string } | undefined;
  return textBlock?.text ?? null;
};

const extractAssistantTextFromOutput = (output: unknown) => {
  if (!output || typeof output !== "object") {
    return null;
  }
  const messages = (output as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return null;
  }
  const assistant = [...messages].reverse().find((message) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    return (message as { role?: string }).role === "assistant";
  });
  return extractMessageText(assistant);
};

const buildMultiAgentHarness = async () => {
  const alphaStream = createStreamFn("assistant:alpha");
  const betaStream = createStreamFn("assistant:beta");

  const config: PiFragmentConfig = {
    agents: {
      alpha: {
        name: "alpha",
        systemPrompt: "You are agent alpha.",
        model: mockModel,
        streamFn: alphaStream,
      },
      beta: {
        name: "beta",
        systemPrompt: "You are agent beta.",
        model: mockModel,
        streamFn: betaStream,
      },
    },
    tools: {},
  };

  return await buildHarness(config);
};

describe("pi-fragment messages route", () => {
  const workflowName = PI_WORKFLOW_NAME;
  let fragments: DatabaseFragmentsTest["fragments"];
  let test: DatabaseFragmentsTest["test"];
  let workflows: DatabaseFragmentsTest["workflows"];

  beforeEach(async () => {
    const result = await buildTestHarness();
    fragments = result.fragments;
    test = result.test;
    workflows = result.workflows;
  });

  afterEach(async () => {
    await test.cleanup();
  });

  it("returns SESSION_NOT_FOUND when session does not exist", async () => {
    const response = await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: "missing-session" },
      body: { text: "hello" },
    });

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error(`Expected error response, got ${response.type}`);
    }
    expect(response.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("returns SESSION_NOT_FOUND when session has no workflow instance", async () => {
    const sessionId = await fragments.pi.db.create("session", {
      name: "Missing workflow",
      agent: "default",
      status: "active",
      workflowInstanceId: null,
      steeringMode: "one-at-a-time",
      metadata: null,
      tags: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: sessionId.valueOf() },
      body: { text: "hello" },
    });

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error(`Expected error response, got ${response.type}`);
    }
    expect(response.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("sends event payload with text, done, and steeringMode", async () => {
    const session = await createSession(fragments);

    const response = await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: session.id },
      body: { text: "hello", done: true, steeringMode: "all" },
    });

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(formatResponseError(response));
    }
    expect(response.status).toBe(202);
    const ack = response.data as Record<string, unknown>;
    expect(SESSION_STATUSES).toContain(ack["status"] as (typeof SESSION_STATUSES)[number]);
    expect(ack["assistant"]).toBeUndefined();

    const history = await workflows.getHistory(workflowName, session.workflowInstanceId ?? "");
    const lastEvent = [...history.events]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .at(-1);

    expect(lastEvent?.type).toBe("user_message");
    expect(lastEvent?.payload).toEqual({ text: "hello", done: true, steeringMode: "all" });
  });

  it("defaults message steeringMode to the session mode when omitted", async () => {
    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Default steering", steeringMode: "all" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    const sessionId = createResponse.data.id;
    const workflowInstanceId = createResponse.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }

    const response = await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "hello" },
    });

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(formatResponseError(response));
    }

    const history = await workflows.getHistory(workflowName, workflowInstanceId);
    const lastEvent = [...history.events]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .at(-1);

    expect(lastEvent?.payload).toMatchObject({ steeringMode: "all" });
  });

  it("persists steeringMode updates on the session row", async () => {
    const session = await createSession(fragments);

    const response = await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: session.id },
      body: { text: "hello", steeringMode: "all" },
    });

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(formatResponseError(response));
    }
    expect(response.status).toBe(202);
    const ack = response.data as Record<string, unknown>;
    expect(SESSION_STATUSES).toContain(ack["status"] as (typeof SESSION_STATUSES)[number]);

    const [row] = await fragments.pi.db.find("session");
    expect(row?.steeringMode).toBe("all");
  });

  it("routes messages to the correct agent streamFn", async () => {
    const multi = await buildMultiAgentHarness();
    const localFragments = multi.fragments;

    try {
      const alphaSession = await createSessionForAgent(localFragments, "alpha", "Alpha Session");
      const betaSession = await createSessionForAgent(localFragments, "beta", "Beta Session");

      const alphaResponse = await localFragments.pi.callRoute(
        "POST",
        "/sessions/:sessionId/messages",
        {
          pathParams: { sessionId: alphaSession.id },
          body: { text: "alpha-message", done: true },
        },
      );
      const betaResponse = await localFragments.pi.callRoute(
        "POST",
        "/sessions/:sessionId/messages",
        {
          pathParams: { sessionId: betaSession.id },
          body: { text: "beta-message", done: true },
        },
      );

      expect(alphaResponse.type).toBe("json");
      expect(betaResponse.type).toBe("json");
      if (alphaResponse.type !== "json" || betaResponse.type !== "json") {
        throw new Error("Expected json responses for multi-agent messages");
      }

      expect(alphaResponse.status).toBe(202);
      expect(betaResponse.status).toBe(202);

      await drainWorkflowRunner(
        multi.workflows,
        workflowName,
        alphaSession.workflowInstanceId ?? "",
      );
      await drainWorkflowRunner(
        multi.workflows,
        workflowName,
        betaSession.workflowInstanceId ?? "",
      );

      const alphaStatus = await multi.workflows.getStatus(
        workflowName,
        alphaSession.workflowInstanceId ?? "",
      );
      const betaStatus = await multi.workflows.getStatus(
        workflowName,
        betaSession.workflowInstanceId ?? "",
      );

      expect(extractAssistantTextFromOutput(alphaStatus.output)).toBe("assistant:alpha");
      expect(extractAssistantTextFromOutput(betaStatus.output)).toBe("assistant:beta");

      const instances = await multi.workflows.db.find("workflow_instance");
      const alphaInstance = instances.find(
        (row: unknown) =>
          String((row as { id?: unknown }).id) === alphaSession.workflowInstanceId &&
          (row as { workflowName?: string }).workflowName === workflowName,
      ) as { params?: unknown } | undefined;
      const betaInstance = instances.find(
        (row: unknown) =>
          String((row as { id?: unknown }).id) === betaSession.workflowInstanceId &&
          (row as { workflowName?: string }).workflowName === workflowName,
      ) as { params?: unknown } | undefined;
      expect((alphaInstance?.params as { agentName?: string } | undefined)?.agentName).toBe(
        "alpha",
      );
      expect((betaInstance?.params as { agentName?: string } | undefined)?.agentName).toBe("beta");
    } finally {
      await multi.test.cleanup();
    }
  });

  it("keeps concurrent session messages and statuses isolated", async () => {
    const sessionA = await createSession(fragments);
    const sessionB = await createSession(fragments);

    const [responseA, responseB] = await Promise.all([
      fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
        pathParams: { sessionId: sessionA.id },
        body: { text: "alpha", done: true },
      }),
      fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
        pathParams: { sessionId: sessionB.id },
        body: { text: "beta", done: false },
      }),
    ]);

    expect(responseA.type).toBe("json");
    expect(responseB.type).toBe("json");
    if (responseA.type !== "json" || responseB.type !== "json") {
      throw new Error("Expected json responses for concurrent messages");
    }
    expect(responseA.status).toBe(202);
    expect(responseB.status).toBe(202);

    await drainWorkflowRunner(workflows, workflowName, sessionA.workflowInstanceId ?? "");
    await drainWorkflowRunner(workflows, workflowName, sessionB.workflowInstanceId ?? "");

    const statusA = await workflows.getStatus(workflowName, sessionA.workflowInstanceId ?? "");
    const statusB = await workflows.getStatus(workflowName, sessionB.workflowInstanceId ?? "");

    expect(statusA.status).toBe("complete");
    expect(statusB.status).toBe("waiting");

    const historyA = await workflows.getHistory(workflowName, sessionA.workflowInstanceId ?? "");
    const historyB = await workflows.getHistory(workflowName, sessionB.workflowInstanceId ?? "");
    const messagesA = (historyA.steps
      .map((step: { result?: unknown }) => {
        if (!step.result || typeof step.result !== "object") {
          return null;
        }
        const result = step.result as Record<string, unknown>;
        return Array.isArray(result["messages"]) ? (result["messages"] as unknown[]) : null;
      })
      .filter((value: unknown): value is unknown[] => Boolean(value))
      .at(-1) ?? []) as Array<{ role?: string; content?: unknown }>;
    const messagesB = (historyB.steps
      .map((step: { result?: unknown }) => {
        if (!step.result || typeof step.result !== "object") {
          return null;
        }
        const result = step.result as Record<string, unknown>;
        return Array.isArray(result["messages"]) ? (result["messages"] as unknown[]) : null;
      })
      .filter((value: unknown): value is unknown[] => Boolean(value))
      .at(-1) ?? []) as Array<{ role?: string; content?: unknown }>;

    const userTextsA = messagesA
      .filter(
        (message: { role?: string; content?: unknown } | null) =>
          message && typeof message === "object" && message.role === "user",
      )
      .map((message: { role?: string; content?: unknown } | null) => extractMessageText(message))
      .filter((text): text is string => Boolean(text));
    const userTextsB = messagesB
      .filter(
        (message: { role?: string; content?: unknown } | null) =>
          message && typeof message === "object" && message.role === "user",
      )
      .map((message: { role?: string; content?: unknown } | null) => extractMessageText(message))
      .filter((text): text is string => Boolean(text));

    expect(userTextsA).toContain("alpha");
    expect(userTextsA).not.toContain("beta");
    expect(userTextsB).toContain("beta");
    expect(userTextsB).not.toContain("alpha");
  });
});
