import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { env } from "cloudflare:workers";

import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import { workflowsFragmentDefinition, workflowsRoutesFactory } from "@fragno-dev/workflows";

import { WORKSPACE_STARTER_CONTENT } from "@/files";

import { AUTOMATION_SYSTEM_ACTOR, type AutomationEvent } from "./contracts";
import { automationFragmentDefinition } from "./definition";
import { createTestMasterFileSystem } from "./engine/test-master-file-system.test-utils";
import { defineAutomationCodemodeWorkflow } from "./engine/workflow";
import { automationFragmentRoutes } from "./routes";

const telegramSendCalls: Array<{ chatId: string; text: string }> = [];
const telegramActionCalls: Array<{ chatId: string; action: string }> = [];
const piCreateSessionCalls: Array<{ agent: string; name?: string | null }> = [];
const piCommandCalls: Array<{ sessionId: string; text: string }> = [];

const createAutomationFileSystem = async () =>
  createTestMasterFileSystem(
    Object.fromEntries(
      Object.entries(WORKSPACE_STARTER_CONTENT).map(([path, content]) => [
        `/workspace/${path.replace(/^\/+/, "")}`,
        content,
      ]),
    ),
  );

const createNdjsonResponse = (items: unknown[]) =>
  new Response(items.map((item) => JSON.stringify(item)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson" },
  });

const createTestEnv = () => {
  const assistantTextBySession = new Map<string, string>();

  return {
    LOADER: env.LOADER,
    DOCS_PUBLIC_BASE_URL: "https://example.com",
    OTP: {
      idFromName: vi.fn((orgId: string) => `otp:${orgId}`),
      get: vi.fn(() => ({
        issueIdentityClaim: vi.fn(),
      })),
    },
    TELEGRAM: {
      idFromName: vi.fn((orgId: string) => `telegram:${orgId}`),
      get: vi.fn(() => ({
        fetch: vi.fn(async (request: Request) => {
          const url = new URL(request.url);
          const pathname = url.pathname;

          if (request.method === "POST" && pathname.endsWith("/send")) {
            const chatId = pathname.split("/chats/")[1]!.split("/")[0]!;
            const body = (await request.json()) as { text?: string };
            telegramSendCalls.push({ chatId, text: body.text ?? "" });
            return Response.json({ ok: true, queued: true });
          }

          if (request.method === "POST" && pathname.endsWith("/actions")) {
            const chatId = pathname.split("/chats/")[1]!.split("/")[0]!;
            const body = (await request.json()) as { action?: string };
            telegramActionCalls.push({ chatId, action: body.action ?? "" });
            return Response.json({ ok: true });
          }

          return Response.json(
            { message: "Not configured", code: "NOT_CONFIGURED" },
            { status: 400 },
          );
        }),
      })),
    },
    PI: {
      idFromName: vi.fn((orgId: string) => `pi:${orgId}`),
      get: vi.fn(() => ({
        fetch: vi.fn(async (request: Request) => {
          const url = new URL(request.url);
          const pathname = url.pathname;

          if (
            request.method === "POST" &&
            pathname === "/api/pi/workflows/interactive-chat-workflow/sessions"
          ) {
            const body = (await request.json()) as {
              input?: { agentName?: string };
              name?: string | null;
            };
            const session = {
              id: "pi-session-1",
              name: body.name ?? null,
              status: "waiting",
              agent: body.input?.agentName ?? "default::openai::gpt-5-mini",
              workflowName: "interactive-chat-workflow",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            };
            piCreateSessionCalls.push({ agent: session.agent, name: session.name });
            return Response.json(session);
          }

          const sessionMatch = pathname.match(/\/sessions\/([^/]+)/u);
          const sessionId = sessionMatch?.[1] ?? "";

          if (request.method === "GET" && pathname.endsWith("/events")) {
            return createNdjsonResponse([
              { type: "snapshot", state: { messages: [] } },
              { type: "turn_end" },
            ]);
          }

          if (request.method === "POST" && pathname.endsWith("/command")) {
            const body = (await request.json()) as {
              input?: { text?: string };
            };
            const text = body.input?.text ?? "";
            piCommandCalls.push({ sessionId, text });
            assistantTextBySession.set(sessionId, `agent:${text}`);
            return Response.json({ status: "active" });
          }

          if (request.method === "GET" && sessionId) {
            const assistantText = assistantTextBySession.get(sessionId) ?? "";
            return Response.json({
              id: sessionId,
              name: "Telegram chat-1",
              status: "waiting",
              agentName: "default::openai::gpt-5-mini",
              workflowName: "interactive-chat-workflow",
              agent: {
                state: {
                  messages: assistantText
                    ? [
                        {
                          role: "assistant",
                          content: [{ type: "text", text: assistantText }],
                        },
                      ]
                    : [],
                },
                events: [],
              },
              workflow: { status: "waiting" },
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            });
          }

          return Response.json(
            { message: "Not configured", code: "NOT_CONFIGURED" },
            { status: 400 },
          );
        }),
      })),
    },
    RESEND: {
      idFromName: vi.fn((orgId: string) => `resend:${orgId}`),
      get: vi.fn(() => ({
        fetch: vi.fn(async () =>
          Response.json({ message: "Not configured", code: "NOT_CONFIGURED" }, { status: 400 }),
        ),
      })),
    },
    RESON8: {
      idFromName: vi.fn((orgId: string) => `reson8:${orgId}`),
      get: vi.fn(() => ({
        fetch: vi.fn(async () =>
          Response.json({ message: "Not configured", code: "NOT_CONFIGURED" }, { status: 400 }),
        ),
      })),
    },
    AUTOMATIONS: {
      idFromName: vi.fn((orgId: string) => `automations:${orgId}`),
      get: vi.fn(() => ({
        fetch: vi.fn(async () =>
          Response.json({ message: "Not configured", code: "NOT_CONFIGURED" }, { status: 400 }),
        ),
      })),
    },
  } as unknown as CloudflareEnv;
};

const readJsonBody = async (request: Request) =>
  request.method === "GET" ? undefined : await request.json();

const routeResultToResponse = (result: {
  type: string;
  data?: unknown;
  error?: unknown;
  status?: number;
}) => {
  if (result.type === "json") {
    return Response.json(result.data, { status: result.status ?? 200 });
  }

  if (result.type === "error") {
    return Response.json(result.error, { status: result.status ?? 500 });
  }

  return Response.json(result, { status: result.status ?? 200 });
};

const callWorkflowsRoute = async ({
  fragment,
  method,
  pathname,
  body,
}: {
  fragment: Awaited<
    ReturnType<typeof buildStarterPiTestContext>
  >["fragments"]["workflows"]["fragment"];
  method: string;
  pathname: string;
  body: unknown;
}) => {
  const segments = pathname.replace(/^\/api\/automations\/?/u, "").split("/");
  const [workflowName, instancesSegment, instanceId] = segments;

  if (!workflowName || instancesSegment !== "instances") {
    return Response.json({ message: `Route ${method} ${pathname} not found` }, { status: 404 });
  }

  if (method === "POST" && !instanceId) {
    return routeResultToResponse(
      await fragment.callRoute("POST", "/:workflowName/instances", {
        pathParams: { workflowName },
        body: body as { id?: string; params?: unknown; remoteWorkflowName?: string },
      }),
    );
  }

  return Response.json({ message: `Route ${method} ${pathname} not found` }, { status: 404 });
};

const buildStarterPiTestContext = async () => {
  const testEnv = createTestEnv();
  const fileSystem = await createAutomationFileSystem();
  const workflowConfig = {
    env: testEnv,
    getAutomationFileSystem: async () => fileSystem,
  };

  const result = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "in-memory" })
    .withFragment(
      "workflows",
      instantiate(workflowsFragmentDefinition)
        .withConfig({
          workflows: {
            AUTOMATION_CODEMODE_SCRIPT: defineAutomationCodemodeWorkflow(workflowConfig),
          },
          runtime: defaultFragnoRuntime,
        })
        .withRoutes([workflowsRoutesFactory]),
    )
    .withFragmentFactory("automation", automationFragmentDefinition, ({ fragments }) =>
      instantiate(automationFragmentDefinition)
        .withConfig({
          env: testEnv,
          createPiAutomationContext: () => ({
            runtime: {
              createSession: vi.fn(),
              getSession: vi.fn(),
              listSessions: vi.fn(),
              runTurn: vi.fn(),
            },
          }),
          getAutomationFileSystem: async () => fileSystem,
        })
        .withServices({ workflows: fragments.workflows.services })
        .withRoutes([automationFragmentRoutes]),
    )
    .build();

  testEnv.AUTOMATIONS.get = (() => ({
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const body = await readJsonBody(request);

      if (url.pathname.startsWith("/api/automations/bindings")) {
        const routePath = url.pathname.replace(/^\/api\/automations\/bindings/u, "") || "/";
        return await result.fragments.automation.fragment.callRouteRaw(
          request.method as never,
          routePath,
          { query: Object.fromEntries(url.searchParams), body },
        );
      }

      if (url.pathname.startsWith("/api/automations")) {
        return await callWorkflowsRoute({
          fragment: result.fragments.workflows.fragment,
          method: request.method,
          pathname: url.pathname,
          body,
        });
      }

      return Response.json({ message: "Not found", code: "NOT_FOUND" }, { status: 404 });
    },
  })) as never;

  return result;
};

const telegramEvent = (id: string, text: string) =>
  ({
    id,
    orgId: "org-1",
    source: "telegram",
    eventType: "message.received",
    occurredAt: "2026-06-06T11:21:04.000Z",
    payload: {
      messageId: `chat-1:${id}`,
      chatId: "chat-1",
      fromUserId: "chat-1",
      text,
    },
    actor: { scope: "external", source: "telegram", type: "chat", id: "chat-1" },
    actors: [{ scope: "external", source: "telegram", type: "chat", id: "chat-1" }],
  }) satisfies AutomationEvent;

describe("starter Pi session automation", () => {
  let context: Awaited<ReturnType<typeof buildStarterPiTestContext>>;

  const drainAll = async () => {
    await drainDurableHooks(context.fragments.automation.fragment);
    await drainDurableHooks(context.fragments.workflows.fragment);
  };

  const ingestPiConfigured = async () => {
    await context.fragments.automation.fragment.callServices(() =>
      context.fragments.automation.services.ingestEvent({
        id: "pi-configured-1",
        orgId: "org-1",
        source: "pi",
        eventType: "capability.configured",
        occurredAt: "2026-06-06T11:21:04.000Z",
        payload: {
          capabilityId: "pi",
          capabilityLabel: "Pi",
          harnesses: [{ id: "default", label: "Default", tools: ["bash"] }],
          modelCatalog: [{ provider: "openai", name: "gpt-5-mini", label: "GPT-5 mini" }],
        },
        actor: AUTOMATION_SYSTEM_ACTOR,
        actors: [AUTOMATION_SYSTEM_ACTOR],
        subject: { orgId: "org-1", capabilityId: "pi" },
      }),
    );
    await drainAll();

    const defaultAgentResponse = await context.fragments.automation.fragment.callRoute(
      "GET",
      "/store/get",
      { query: { key: "pi/pi-default-agent" } },
    );
    if (defaultAgentResponse.type !== "json") {
      throw new Error("Expected Pi configuration automation to store the default Pi agent.");
    }
    expect(defaultAgentResponse.data).toMatchObject({
      key: "pi/pi-default-agent",
      value: "default::openai::gpt-5-mini",
    });
  };

  beforeEach(async () => {
    telegramSendCalls.length = 0;
    telegramActionCalls.length = 0;
    piCreateSessionCalls.length = 0;
    piCommandCalls.length = 0;
    context = await buildStarterPiTestContext();
  });

  afterEach(async () => {
    await context?.test.cleanup();
  });

  test("creates a durable Pi session workflow for /pi on a linked chat", async () => {
    const { automation, workflows } = context.fragments;

    await automation.fragment.callRoute("POST", "/store/set", {
      body: {
        key: "telegram/chat-1",
        value: "user-1",
        actor: { scope: "external", source: "telegram", type: "chat", id: "chat-1" },
      },
    });
    await ingestPiConfigured();

    await automation.fragment.callServices(() =>
      automation.services.ingestEvent(telegramEvent("telegram-pi-1", "/pi")),
    );
    await drainAll();

    expect(piCreateSessionCalls).toEqual([
      { agent: "default::openai::gpt-5-mini", name: "Telegram chat-1" },
    ]);
    expect(telegramSendCalls).toEqual([
      { chatId: "chat-1", text: "Created Pi session: pi-session-1" },
    ]);

    const workflowStatus = await workflows.fragment.callServices(() =>
      workflows.services.getInstanceStatus(
        "automation-codemode-script",
        "telegram-pi-telegram-pi-1",
      ),
    );
    expect(workflowStatus).toMatchObject({ status: "complete" });
  });

  test("reuses the stored Pi session for a linked chat message", async () => {
    const { automation } = context.fragments;

    await automation.fragment.callRoute("POST", "/store/set", {
      body: {
        key: "telegram/chat-1",
        value: "user-1",
        actor: { scope: "external", source: "telegram", type: "chat", id: "chat-1" },
      },
    });
    await ingestPiConfigured();

    await automation.fragment.callServices(() =>
      automation.services.ingestEvent(telegramEvent("telegram-pi-1", "/pi")),
    );
    await drainAll();

    await automation.fragment.callServices(() =>
      automation.services.ingestEvent(telegramEvent("telegram-pi-2", "Hello Pi")),
    );
    await drainAll();

    expect(piCreateSessionCalls).toHaveLength(1);
    expect(telegramActionCalls).toEqual([{ chatId: "chat-1", action: "typing" }]);
    expect(piCommandCalls).toEqual([{ sessionId: "pi-session-1", text: "Hello Pi" }]);
    expect(telegramSendCalls).toEqual([
      { chatId: "chat-1", text: "Created Pi session: pi-session-1" },
      { chatId: "chat-1", text: "agent:Hello Pi" },
    ]);
  });
});
