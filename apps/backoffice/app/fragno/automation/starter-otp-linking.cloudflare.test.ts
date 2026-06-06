import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { env } from "cloudflare:workers";

import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";
import { workflowsFragmentDefinition, workflowsRoutesFactory } from "@fragno-dev/workflows";

import { createMasterFileSystem, type FilesContext } from "@/files";

import type { AutomationEvent } from "./contracts";
import { automationFragmentDefinition } from "./definition";
import { defineAutomationCodemodeWorkflow } from "./engine/workflow";
import { automationFragmentRoutes } from "./routes";

const telegramSendCalls: Array<{ chatId: string; text: string }> = [];
const issueIdentityClaimMock = vi.fn(async ({ externalActorId }: { externalActorId: string }) => ({
  url: `https://example.com/claims/${externalActorId}`,
  otpId: "otp-1",
  externalId: externalActorId,
  code: "123456",
  type: "otp",
}));

const createAutomationFileSystem = async () =>
  await createMasterFileSystem({
    orgId: "org-1",
    backend: "backoffice",
    uploadConfig: null,
  } satisfies FilesContext);

const createTestEnv = () =>
  ({
    LOADER: env.LOADER,
    DOCS_PUBLIC_BASE_URL: "https://example.com",
    OTP: {
      idFromName: vi.fn((orgId: string) => `otp:${orgId}`),
      get: vi.fn(() => ({
        issueIdentityClaim: issueIdentityClaimMock,
      })),
    },
    TELEGRAM: {
      idFromName: vi.fn((orgId: string) => `telegram:${orgId}`),
      get: vi.fn(() => ({
        fetch: vi.fn(async (request: Request) => {
          const url = new URL(request.url);
          if (request.method === "POST" && url.pathname.endsWith("/send")) {
            const chatId = url.pathname.split("/chats/")[1]!.split("/")[0]!;
            const body = (await request.json()) as { text?: string };
            telegramSendCalls.push({ chatId, text: body.text ?? "" });
            return Response.json({ ok: true, queued: true });
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
        fetch: vi.fn(async () =>
          Response.json({ message: "Not configured", code: "NOT_CONFIGURED" }, { status: 400 }),
        ),
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
  }) as unknown as CloudflareEnv;

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
    ReturnType<typeof buildStarterAutomationTestContext>
  >["fragments"]["workflows"]["fragment"];
  method: string;
  pathname: string;
  body: unknown;
}) => {
  const segments = pathname.replace(/^\/api\/automations\/?/u, "").split("/");
  const [workflowName, instancesSegment, instanceId, suffix] = segments;
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

  if (method === "POST" && instanceId && suffix === "events") {
    return routeResultToResponse(
      await fragment.callRoute("POST", "/:workflowName/instances/:instanceId/events", {
        pathParams: { workflowName, instanceId },
        body: body as { id?: string; type: string; payload?: unknown },
      }),
    );
  }

  return Response.json({ message: `Route ${method} ${pathname} not found` }, { status: 404 });
};

const buildStarterAutomationTestContext = async () => {
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

const telegramStartEvent = {
  id: "telegram-start-1",
  orgId: "org-1",
  source: "telegram",
  eventType: "message.received",
  occurredAt: "2026-06-05T10:00:00.000Z",
  payload: { text: "/start", chatId: "chat-1" },
  actor: { type: "external", externalId: "chat-1" },
  subject: null,
} satisfies AutomationEvent;

const otpCompletedEvent = {
  id: "otp-complete-1",
  orgId: "org-1",
  source: "otp",
  eventType: "identity.claim.completed",
  occurredAt: "2026-06-05T10:01:00.000Z",
  payload: {
    otpId: "otp-1",
    claimType: "identity_link",
    linkSource: "telegram",
    externalActorId: "chat-1",
  },
  actor: null,
  subject: { userId: "user-1" },
} satisfies AutomationEvent;

describe("starter OTP linking automation", () => {
  let context: Awaited<ReturnType<typeof buildStarterAutomationTestContext>>;

  const drainAll = async () => {
    await drainDurableHooks(context.fragments.automation.fragment);
    await drainDurableHooks(context.fragments.workflows.fragment);
  };

  beforeEach(async () => {
    telegramSendCalls.length = 0;
    issueIdentityClaimMock.mockClear();
    context = await buildStarterAutomationTestContext();
  });

  afterEach(async () => {
    await context?.test.cleanup();
  });

  test("routes Telegram /start into the starter workflow and links after OTP completion", async () => {
    const { automation, workflows } = context.fragments;

    await automation.fragment.callServices(() =>
      automation.services.ingestEvent(telegramStartEvent),
    );
    await drainAll();

    expect(issueIdentityClaimMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        linkSource: "telegram",
        externalActorId: "chat-1",
        publicBaseUrl: "https://example.com",
      }),
    );
    expect(telegramSendCalls).toEqual([
      {
        chatId: "chat-1",
        text: "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
      },
    ]);

    await automation.fragment.callServices(() =>
      automation.services.ingestEvent(otpCompletedEvent),
    );
    await drainAll();

    const bindingResponse = await automation.fragment.callRoute(
      "GET",
      "/identity-bindings/lookup",
      {
        query: { source: "telegram", key: "chat-1" },
      },
    );
    expect(bindingResponse.type).toBe("json");
    if (bindingResponse.type === "json") {
      expect(bindingResponse.data).toMatchObject({
        source: "telegram",
        key: "chat-1",
        value: "user-1",
        status: "linked",
      });
    }

    const startWorkflowStatus = await workflows.fragment.callServices(() =>
      workflows.services.getInstanceStatus(
        "automation-codemode-script",
        "telegram-link-telegram-start-1",
      ),
    );
    expect(startWorkflowStatus).toMatchObject({ status: "complete" });
    expect(telegramSendCalls).toEqual([
      {
        chatId: "chat-1",
        text: "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
      },
      { chatId: "chat-1", text: "Your Telegram chat is now linked." },
    ]);
  });

  test("starts separate Telegram link workflows for separate /start event ids", async () => {
    const { automation, workflows } = context.fragments;

    await automation.fragment.callServices(() =>
      automation.services.ingestEvent(telegramStartEvent),
    );
    await automation.fragment.callServices(() =>
      automation.services.ingestEvent({ ...telegramStartEvent, id: "telegram-start-2" }),
    );
    await drainAll();

    expect(issueIdentityClaimMock).toHaveBeenCalledTimes(2);
    await expect(
      workflows.fragment.callServices(() =>
        workflows.services.getInstanceStatus(
          "automation-codemode-script",
          "telegram-link-telegram-start-1",
        ),
      ),
    ).resolves.toMatchObject({ status: "waiting" });
    await expect(
      workflows.fragment.callServices(() =>
        workflows.services.getInstanceStatus(
          "automation-codemode-script",
          "telegram-link-telegram-start-2",
        ),
      ),
    ).resolves.toMatchObject({ status: "waiting" });
  });

  test("routes Telegram /test into an event-id keyed delayed reply workflow", async () => {
    const { automation, workflows } = context.fragments;

    await automation.fragment.callServices(() =>
      automation.services.ingestEvent({
        ...telegramStartEvent,
        id: "telegram-test-1",
        payload: { text: "/test", chatId: "chat-1" },
      }),
    );
    await drainAll();

    const workflowStatus = await workflows.fragment.callServices(() =>
      workflows.services.getInstanceStatus(
        "automation-codemode-script",
        "telegram-test-telegram-test-1",
      ),
    );
    expect(workflowStatus).toMatchObject({ status: "waiting" });
    expect(telegramSendCalls).toEqual([]);
  });

  test("does not issue a new claim for an already linked Telegram chat", async () => {
    const { automation } = context.fragments;

    await automation.fragment.callRoute("POST", "/identity-bindings/bind", {
      body: { source: "telegram", key: "chat-1", value: "user-1" },
    });

    await automation.fragment.callServices(() =>
      automation.services.ingestEvent(telegramStartEvent),
    );
    await drainAll();

    expect(issueIdentityClaimMock).not.toHaveBeenCalled();
    expect(telegramSendCalls).toEqual([
      { chatId: "chat-1", text: "This Telegram chat is already linked." },
    ]);
  });

  test("ignores non-Telegram identity claim completions", async () => {
    const { automation } = context.fragments;

    await automation.fragment.callServices(() =>
      automation.services.ingestEvent({
        ...otpCompletedEvent,
        id: "github-otp-complete-1",
        payload: { ...otpCompletedEvent.payload, linkSource: "github" },
      }),
    );
    await drainAll();

    const bindingResponse = await automation.fragment.callRoute(
      "GET",
      "/identity-bindings/lookup",
      {
        query: { source: "telegram", key: "chat-1" },
      },
    );
    expect(bindingResponse.type).toBe("error");
    expect(telegramSendCalls).toEqual([]);
  });
});
