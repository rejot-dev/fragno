import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamFn } from "@mariozechner/pi-agent-core";

import type { PiFragmentConfig } from "./pi/types";
import { PI_WORKFLOW_NAME } from "./pi/workflow";
import {
  buildHarness,
  createStreamFn,
  createFailingStreamFn,
  createInvalidResultStreamFn,
  createDelayedStreamFn,
  drainWorkflowRunner,
  mockModel,
  type DatabaseFragmentsTest,
} from "./pi/test-utils";

const extractAssistantText = (assistant: unknown): string => {
  if (!assistant || typeof assistant !== "object") {
    return "";
  }

  const content = (assistant as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  const textBlock = content.find((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return (block as { type?: string }).type === "text";
  }) as { text?: string } | undefined;

  return textBlock?.text ?? "";
};

const extractAssistantTextFromMessages = (messages: unknown[]): string => {
  const assistant = [...messages].reverse().find((message) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    return (message as { role?: string }).role === "assistant";
  });
  return extractAssistantText(assistant);
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

const setupStreamHarness = async (streamFn: StreamFn) => {
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

  const result = await buildHarness(config);
  return { fragments: result.fragments, test: result.test, workflows: result.workflows };
};

describe("pi-fragment sessions", () => {
  const workflowName = PI_WORKFLOW_NAME;
  let fragments: DatabaseFragmentsTest["fragments"];
  let test: DatabaseFragmentsTest["test"];
  let workflows: DatabaseFragmentsTest["workflows"];
  let sessionCounter = 0;

  beforeEach(async () => {
    const streamFn = createStreamFn("assistant:stream");
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

    const result = await buildHarness(config);
    fragments = result.fragments;
    test = result.test;
    workflows = result.workflows;
    sessionCounter = 0;
  });

  afterEach(async () => {
    await test.cleanup();
  });

  const createSessionRow = async (options: {
    name?: string;
    status?: string;
    workflowInstanceId?: string | null;
    createdAt?: Date;
  }) => {
    sessionCounter += 1;
    const now = options.createdAt ?? new Date();
    return fragments.pi.db.create("session", {
      name: options.name ?? `Session ${sessionCounter}`,
      agent: "default",
      status: options.status ?? "active",
      workflowInstanceId: options.workflowInstanceId ?? null,
      steeringMode: "one-at-a-time",
      metadata: null,
      tags: null,
      createdAt: now,
      updatedAt: now,
    });
  };

  it("rejects session creation with unknown agent", async () => {
    const response = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "missing" },
    });

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error(`Expected error response, got ${response.type}`);
    }
    expect(response.error.code).toBe("AGENT_NOT_FOUND");
  });

  it("stores metadata, tags, and steeringMode on session creation", async () => {
    const metadata = { team: "alpha", priority: 3 };
    const tags = ["tag-a", "tag-b"];

    const response = await fragments.pi.callRoute("POST", "/sessions", {
      body: {
        agent: "default",
        name: "Tagged Session",
        metadata,
        tags,
        steeringMode: "all",
      },
    });

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(formatResponseError(response));
    }

    expect(response.data.metadata).toEqual(metadata);
    expect(response.data.tags).toEqual(tags);
    expect(response.data.steeringMode).toBe("all");

    const sessions = await fragments.pi.db.find("session");
    expect(sessions).toHaveLength(1);
    const row = sessions[0] as { metadata?: unknown; tags?: unknown; steeringMode?: string };
    expect(row.metadata).toEqual(metadata);
    expect(row.tags).toEqual(tags);
    expect(row.steeringMode).toBe("all");
  });

  it("deletes session when workflow creation fails", async () => {
    const streamFn = createStreamFn("assistant:stream");
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
    const local = await buildHarness(config, {
      wrapWorkflowsService: (service) => ({
        ...service,
        createInstance: () => {
          throw new Error("CREATE_FAILED");
        },
      }),
    });

    const response = await local.fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Failure Session" },
    });

    expect(response.type).toBe("error");
    if (response.type !== "error") {
      throw new Error(`Expected error response, got ${response.type}`);
    }
    expect(response.error.code).toBe("WORKFLOW_CREATE_FAILED");

    const sessions = await local.fragments.pi.db.find("session");
    expect(sessions).toHaveLength(0);
    await local.test.cleanup();
  });

  it("persists workflow status from createInstance details", async () => {
    const response = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Paused Session" },
    });

    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(formatResponseError(response));
    }
    const workflowInstanceId = response.data.workflowInstanceId ?? "";
    const workflowStatus = await workflows.getStatus(workflowName, workflowInstanceId);
    expect(response.data.status).toBe(workflowStatus.status);

    const sessions = await fragments.pi.db.find("session");
    expect(sessions).toHaveLength(1);
    const row = sessions[0] as { status?: string };
    expect(row.status).toBe(workflowStatus.status);
  });

  it("creates sessions and lists workflow-derived status", async () => {
    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Session A", tags: ["alpha"] },
    });

    expect(createResponse.type).toBe("json");
    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    expect(createResponse.data.agent).toBe("default");
    expect(createResponse.data.workflowInstanceId).toBeTruthy();
    const workflowInstanceId = createResponse.data.workflowInstanceId ?? "";
    const workflowStatus = await workflows.getStatus(workflowName, workflowInstanceId);
    expect(createResponse.data.status).toBe(workflowStatus.status);

    const listResponse = await fragments.pi.callRoute("GET", "/sessions", {});

    expect(listResponse.type).toBe("json");
    if (listResponse.type !== "json") {
      throw new Error(formatResponseError(listResponse));
    }
    expect(listResponse.data).toHaveLength(1);
    expect(listResponse.data[0].status).toBe(workflowStatus.status);
  });

  it("defaults list limit to 50 and clamps to minimum of 1", async () => {
    const baseTime = new Date("2024-01-01T00:00:00.000Z");
    for (let i = 0; i < 60; i += 1) {
      await createSessionRow({
        createdAt: new Date(baseTime.getTime() + i * 1000),
      });
    }

    const defaultResponse = await fragments.pi.callRoute("GET", "/sessions", {});
    expect(defaultResponse.type).toBe("json");
    if (defaultResponse.type !== "json") {
      throw new Error(formatResponseError(defaultResponse));
    }
    expect(defaultResponse.data).toHaveLength(50);

    const clampResponse = await fragments.pi.callRoute("GET", "/sessions", {
      query: { limit: "0" },
    });
    expect(clampResponse.type).toBe("json");
    if (clampResponse.type !== "json") {
      throw new Error(formatResponseError(clampResponse));
    }
    expect(clampResponse.data).toHaveLength(1);
  });

  it("clamps list limit to a maximum of 200", async () => {
    const baseTime = new Date("2024-01-02T00:00:00.000Z");
    for (let i = 0; i < 205; i += 1) {
      await createSessionRow({
        createdAt: new Date(baseTime.getTime() + i * 1000),
      });
    }

    const response = await fragments.pi.callRoute("GET", "/sessions", {
      query: { limit: "1000" },
    });
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(formatResponseError(response));
    }
    expect(response.data).toHaveLength(200);
  });

  it("orders sessions by createdAt descending", async () => {
    const first = await createSessionRow({
      name: "Oldest",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    const second = await createSessionRow({
      name: "Middle",
      createdAt: new Date("2024-01-02T00:00:00.000Z"),
    });
    const third = await createSessionRow({
      name: "Newest",
      createdAt: new Date("2024-01-03T00:00:00.000Z"),
    });

    const response = await fragments.pi.callRoute("GET", "/sessions", {});
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(formatResponseError(response));
    }

    const ids = response.data.slice(0, 3).map((session: { id: string }) => session.id);
    expect(ids).toEqual([third.valueOf(), second.valueOf(), first.valueOf()]);
  });

  it("skips status hydration when workflowInstanceId is missing", async () => {
    await createSessionRow({
      name: "No workflow",
      workflowInstanceId: null,
    });

    const response = await fragments.pi.callRoute("GET", "/sessions", {});
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(formatResponseError(response));
    }

    expect(response.data).toHaveLength(1);
    expect(response.data[0]?.workflowInstanceId).toBeNull();
  });

  it("hydrates statuses from the workflows service", async () => {
    const sessionA = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Batch A" },
    });
    const sessionB = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Batch B" },
    });
    if (sessionA.type !== "json" || sessionB.type !== "json") {
      throw new Error("Expected session creation to succeed");
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: sessionA.data.id },
      body: { text: "done", done: true },
    });
    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId: sessionB.data.id },
      body: { text: "waiting", done: false },
    });

    const response = await fragments.pi.callRoute("GET", "/sessions", {});
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(formatResponseError(response));
    }

    const statusById = new Map(
      response.data.map((session: { workflowInstanceId?: string | null; status?: string }) => [
        session.workflowInstanceId,
        session.status,
      ]),
    );
    const statusA = await workflows.getStatus(workflowName, sessionA.data.workflowInstanceId ?? "");
    const statusB = await workflows.getStatus(workflowName, sessionB.data.workflowInstanceId ?? "");

    expect(statusById.get(sessionA.data.workflowInstanceId)).toBe(statusA.status);
    expect(statusById.get(sessionB.data.workflowInstanceId)).toBe(statusB.status);
  });

  it("keeps session status when per-session hydration fails", async () => {
    const sessionA = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Per-session A" },
    });
    const sessionB = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Per-session B" },
    });
    if (sessionA.type !== "json" || sessionB.type !== "json") {
      throw new Error("Expected session creation to succeed");
    }

    const instanceIdToRemove = sessionB.data.workflowInstanceId ?? "";
    const instances = await workflows.db.find("workflow_instance");
    const instanceRow = instances.find(
      (row: unknown) =>
        String((row as { id?: unknown }).id) === instanceIdToRemove &&
        (row as { workflowName?: string }).workflowName === workflowName,
    ) as { id?: string } | undefined;
    if (instanceRow?.id) {
      await workflows.db.update("workflow_instance", instanceRow.id, (b) =>
        b.set({ workflowName: "missing-workflow" }),
      );
    }

    const response = await fragments.pi.callRoute("GET", "/sessions", {});
    expect(response.type).toBe("json");
    if (response.type !== "json") {
      throw new Error(formatResponseError(response));
    }

    const statusById = new Map(
      response.data.map((session: { workflowInstanceId?: string | null; status?: string }) => [
        session.workflowInstanceId,
        session.status,
      ]),
    );
    const statusA = await workflows.getStatus(workflowName, sessionA.data.workflowInstanceId ?? "");

    expect(statusById.get(sessionA.data.workflowInstanceId)).toBe(statusA.status);
    expect(statusById.get(sessionB.data.workflowInstanceId)).toBe(sessionB.data.status);
  });

  it("returns session details with derived messages and summaries", async () => {
    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Session Detail" },
    });

    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    const sessionId = createResponse.data.id;
    const workflowInstanceId = createResponse.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }

    await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "ping" },
    });
    await drainWorkflowRunner(workflows, workflowName, workflowInstanceId);

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.messages.length).toBeGreaterThan(0);
    expect(detailResponse.data.trace.length).toBeGreaterThan(0);
    expect(detailResponse.data.summaries.length).toBeGreaterThan(0);
    expect(detailResponse.data.summaries[0]?.summary).toContain("assistant");
  });

  it("honors steeringMode on session creation", async () => {
    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Steering Mode", steeringMode: "all" },
    });

    expect(createResponse.type).toBe("json");
    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    expect(createResponse.data.steeringMode).toBe("all");
  });

  it("persists and forwards steeringMode on message events", async () => {
    const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
      body: { agent: "default", name: "Steering Updates" },
    });

    expect(createResponse.type).toBe("json");
    if (createResponse.type !== "json") {
      throw new Error(formatResponseError(createResponse));
    }

    const sessionId = createResponse.data.id;
    const workflowInstanceId = createResponse.data.workflowInstanceId;
    if (!workflowInstanceId) {
      throw new Error("Expected workflow instance id");
    }

    const messageResponse = await fragments.pi.callRoute("POST", "/sessions/:sessionId/messages", {
      pathParams: { sessionId },
      body: { text: "ping", steeringMode: "all" },
    });

    expect(messageResponse.type).toBe("json");
    if (messageResponse.type !== "json") {
      throw new Error(formatResponseError(messageResponse));
    }

    const history = await workflows.getHistory(workflowName, workflowInstanceId);
    const lastEvent = [...history.events]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .at(-1);
    expect(lastEvent?.payload).toMatchObject({ steeringMode: "all" });

    const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
      pathParams: { sessionId },
    });

    expect(detailResponse.type).toBe("json");
    if (detailResponse.type !== "json") {
      throw new Error(formatResponseError(detailResponse));
    }

    expect(detailResponse.data.steeringMode).toBe("all");
  });
});

describe("pi-fragment streamFn behavior", () => {
  const workflowName = PI_WORKFLOW_NAME;
  it("uses stream result when streaming succeeds", async () => {
    const streamFn = createStreamFn("assistant:success");
    const { fragments, test, workflows } = await setupStreamHarness(streamFn);

    try {
      const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
        body: { agent: "default", name: "Stream success" },
      });
      if (createResponse.type !== "json") {
        throw new Error(formatResponseError(createResponse));
      }

      const sessionId = createResponse.data.id;
      const workflowInstanceId = createResponse.data.workflowInstanceId;
      if (!workflowInstanceId) {
        throw new Error("Expected workflow instance id");
      }

      const messageResponse = await fragments.pi.callRoute(
        "POST",
        "/sessions/:sessionId/messages",
        {
          pathParams: { sessionId },
          body: { text: "hello" },
        },
      );

      expect(messageResponse.type).toBe("json");
      if (messageResponse.type !== "json") {
        throw new Error(formatResponseError(messageResponse));
      }
      expect(messageResponse.status).toBe(202);

      await drainWorkflowRunner(workflows, workflowName, workflowInstanceId);

      const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
        pathParams: { sessionId },
      });

      expect(detailResponse.type).toBe("json");
      if (detailResponse.type !== "json") {
        throw new Error(formatResponseError(detailResponse));
      }
      expect(extractAssistantTextFromMessages(detailResponse.data.messages)).toBe(
        "assistant:success",
      );
      expect(detailResponse.data.trace.length).toBeGreaterThan(0);
      expect(
        detailResponse.data.trace.some(
          (event: unknown) =>
            event &&
            typeof event === "object" &&
            "type" in event &&
            event.type === "message_update",
        ),
      ).toBe(true);
    } finally {
      await test.cleanup();
    }
  });

  it("falls back to generated assistant message on stream result failure", async () => {
    const streamFn = createFailingStreamFn({ failOnceForText: "fallback" });
    const { fragments, test, workflows } = await setupStreamHarness(streamFn);

    try {
      const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
        body: { agent: "default", name: "Stream failure" },
      });
      if (createResponse.type !== "json") {
        throw new Error(formatResponseError(createResponse));
      }

      const sessionId = createResponse.data.id;
      const workflowInstanceId = createResponse.data.workflowInstanceId;
      if (!workflowInstanceId) {
        throw new Error("Expected workflow instance id");
      }

      const messageResponse = await fragments.pi.callRoute(
        "POST",
        "/sessions/:sessionId/messages",
        {
          pathParams: { sessionId },
          body: { text: "fallback" },
        },
      );

      expect(messageResponse.type).toBe("json");
      if (messageResponse.type !== "json") {
        throw new Error(formatResponseError(messageResponse));
      }
      expect(messageResponse.status).toBe(202);

      await drainWorkflowRunner(workflows, workflowName, workflowInstanceId);

      const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
        pathParams: { sessionId },
      });

      expect(detailResponse.type).toBe("json");
      if (detailResponse.type !== "json") {
        throw new Error(formatResponseError(detailResponse));
      }
      expect(extractAssistantTextFromMessages(detailResponse.data.messages)).toBe(
        "assistant:fallback",
      );
    } finally {
      await test.cleanup();
    }
  });

  it("falls back when stream result is invalid", async () => {
    const streamFn = createInvalidResultStreamFn();
    const { fragments, test, workflows } = await setupStreamHarness(streamFn);

    try {
      const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
        body: { agent: "default", name: "Stream invalid" },
      });
      if (createResponse.type !== "json") {
        throw new Error(formatResponseError(createResponse));
      }

      const sessionId = createResponse.data.id;
      const workflowInstanceId = createResponse.data.workflowInstanceId;
      if (!workflowInstanceId) {
        throw new Error("Expected workflow instance id");
      }

      const messageResponse = await fragments.pi.callRoute(
        "POST",
        "/sessions/:sessionId/messages",
        {
          pathParams: { sessionId },
          body: { text: "invalid" },
        },
      );

      expect(messageResponse.type).toBe("json");
      if (messageResponse.type !== "json") {
        throw new Error(formatResponseError(messageResponse));
      }
      expect(messageResponse.status).toBe(202);

      await drainWorkflowRunner(workflows, workflowName, workflowInstanceId);

      const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
        pathParams: { sessionId },
      });

      expect(detailResponse.type).toBe("json");
      if (detailResponse.type !== "json") {
        throw new Error(formatResponseError(detailResponse));
      }
      expect(extractAssistantTextFromMessages(detailResponse.data.messages)).toBe(
        "assistant:invalid",
      );
    } finally {
      await test.cleanup();
    }
  });

  it("handles delayed streams without losing trace", async () => {
    const streamFn = createDelayedStreamFn(15);
    const { fragments, test, workflows } = await setupStreamHarness(streamFn);

    try {
      const createResponse = await fragments.pi.callRoute("POST", "/sessions", {
        body: { agent: "default", name: "Stream delayed" },
      });
      if (createResponse.type !== "json") {
        throw new Error(formatResponseError(createResponse));
      }

      const sessionId = createResponse.data.id;
      const workflowInstanceId = createResponse.data.workflowInstanceId;
      if (!workflowInstanceId) {
        throw new Error("Expected workflow instance id");
      }

      const messageResponse = await fragments.pi.callRoute(
        "POST",
        "/sessions/:sessionId/messages",
        {
          pathParams: { sessionId },
          body: { text: "delayed" },
        },
      );

      expect(messageResponse.type).toBe("json");
      if (messageResponse.type !== "json") {
        throw new Error(formatResponseError(messageResponse));
      }
      expect(messageResponse.status).toBe(202);

      await drainWorkflowRunner(workflows, workflowName, workflowInstanceId);

      const detailResponse = await fragments.pi.callRoute("GET", "/sessions/:sessionId", {
        pathParams: { sessionId },
      });

      expect(detailResponse.type).toBe("json");
      if (detailResponse.type !== "json") {
        throw new Error(formatResponseError(detailResponse));
      }
      expect(extractAssistantTextFromMessages(detailResponse.data.messages)).toBe(
        "assistant:delayed",
      );
      expect(detailResponse.data.trace.length).toBeGreaterThan(0);
    } finally {
      await test.cleanup();
    }
  });
});
