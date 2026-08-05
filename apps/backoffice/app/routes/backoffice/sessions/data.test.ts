import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { requireBackofficeContextMock } = vi.hoisted(() => ({
  requireBackofficeContextMock: vi.fn(),
}));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

import { createPiSession, fetchPiSessions, sendPiSessionMessage } from "./data";

const scope = { kind: "org" as const, orgId: "org-1" };
const execution = {
  scope,
  actors: {
    initiator: {
      scope: "internal" as const,
      type: "backoffice",
      id: "interactive",
      role: "initiator" as const,
    },
    principal: {
      scope: "internal" as const,
      type: "user",
      id: "user-1",
      role: "principal" as const,
    },
    delegation: [],
  },
};

beforeEach(() => {
  requireBackofficeContextMock.mockReset();
  requireBackofficeContextMock.mockResolvedValue(execution);
});

describe("Pi session route caller", () => {
  test("propagates authorization failures while listing sessions", async () => {
    requireBackofficeContextMock.mockRejectedValue(new Response("Forbidden", { status: 403 }));

    await expect(
      fetchPiSessions(
        new Request("https://backoffice.example/cadence"),
        { get: vi.fn() } as never,
        scope,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("propagates authorization failures while creating sessions", async () => {
    requireBackofficeContextMock.mockRejectedValue(new Response("Forbidden", { status: 403 }));

    await expect(
      createPiSession(
        new Request("https://backoffice.example/backoffice/sessions/org-1", { method: "POST" }),
        { get: vi.fn() } as never,
        scope,
        {
          metadata: { model: { provider: "openai", name: "gpt-5" } },
          input: {},
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("propagates authorization failures returned by Pi middleware", async () => {
    const context = {
      get: () => ({
        runtime: { objects: { pi: {} } },
        kernel: {
          scoped: () => ({
            fetchWithContext: async () =>
              Response.json(
                { message: "Permission denied", code: "principal-permission-denied" },
                { status: 403 },
              ),
          }),
        },
      }),
    };

    await expect(
      createPiSession(
        new Request("https://backoffice.example/backoffice/sessions/org-1", { method: "POST" }),
        context as never,
        scope,
        {
          metadata: { model: { provider: "openai", name: "gpt-5" } },
          input: {},
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("propagates authorization failures while sending session commands", async () => {
    requireBackofficeContextMock.mockRejectedValue(new Response("Forbidden", { status: 403 }));

    await expect(
      sendPiSessionMessage(
        new Request("https://backoffice.example/backoffice/sessions/org-1", { method: "POST" }),
        { get: vi.fn() } as never,
        scope,
        "interactive-chat-workflow",
        "session-1",
        { text: "Hello" },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("forwards session creation with trusted execution context", async () => {
    const fetchWithContext = vi.fn(async (_request: Request, _context: unknown) =>
      Response.json({
        id: "session-1",
        workflowName: "interactive-chat-workflow",
        status: "pending",
      }),
    );
    const fetch = vi.fn();
    const piObject = { fetch, fetchWithContext };
    const kernel = {
      scoped: vi.fn(() => piObject),
    };
    const context = {
      get: () => ({
        runtime: { objects: { pi: {} } },
        kernel,
      }),
    };
    const request = new Request("https://backoffice.example/backoffice/sessions/org-1", {
      method: "POST",
      headers: { cookie: "session=test" },
    });

    await expect(
      createPiSession(request, context as never, scope, {
        metadata: { model: { provider: "openai", name: "gpt-5" } },
        input: {},
      }),
    ).resolves.toMatchObject({
      session: { id: "session-1" },
      error: null,
    });

    expect(requireBackofficeContextMock).toHaveBeenCalledWith(request, context, scope);
    expect(kernel.scoped).toHaveBeenCalledWith("AUTOMATIONS", scope, undefined);
    expect(fetchWithContext).toHaveBeenCalledOnce();
    const [forwardedRequest, actionContext] = fetchWithContext.mock.calls[0]!;
    assert.instanceOf(forwardedRequest, Request);
    assert.equal(forwardedRequest.method, "POST");
    assert.equal(
      new URL(forwardedRequest.url).pathname,
      "/api/pi/workflows/interactive-chat-workflow/sessions",
    );
    expect(actionContext).toEqual({ execution, propagationContext: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});
