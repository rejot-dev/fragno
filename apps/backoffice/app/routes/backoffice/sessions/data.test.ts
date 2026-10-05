import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { requireBackofficeContextMock } = vi.hoisted(() => ({
  requireBackofficeContextMock: vi.fn(),
}));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

import {
  createPiManagerSession,
  fetchPiManagerSessions,
  fetchPiManagerSessionViewStream,
  submitPiManagerPrompt,
} from "./data";

const scope = { kind: "org" as const, orgId: "org-1" };
const execution = {
  kind: "deferred" as const,
  scopeRestriction: null,
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

describe("Pi manager session route caller", () => {
  test("propagates authorization failures before listing sessions", async () => {
    requireBackofficeContextMock.mockRejectedValue(new Response("Forbidden", { status: 403 }));

    await expect(
      fetchPiManagerSessions(
        new Request("https://backoffice.example/sessions"),
        { get: vi.fn() } as never,
        scope,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("creates sessions through PI_MANAGER with trusted execution context", async () => {
    const fetchAuthorized = vi.fn(async (request: Request, _actionContext: unknown) => {
      const body = (await request.clone().json()) as Record<string, unknown>;
      return Response.json(
        {
          ...body,
          scopeRestriction: null,
          scope,
          sessionId: "session-1",
          actors: execution.actors,
        },
        { status: 201 },
      );
    });
    const manager = { http: { fetchAuthorized } };
    const kernel = { scoped: vi.fn(() => manager) };
    const context = {
      get: () => ({ runtime: { objects: { piManager: {} } }, kernel }),
    };
    const request = new Request("https://backoffice.example/sessions", { method: "POST" });

    await expect(
      createPiManagerSession(request, context as never, scope, {
        name: "New session",
        model: { provider: "openai", modelId: "gpt-5.6-luna" },
        instructions: "",
        billingOrganizationId: null,
      }),
    ).resolves.toMatchObject({ session: { sessionId: "session-1" }, error: null });

    expect(kernel.scoped).toHaveBeenCalledWith("PI_MANAGER", scope, {});
    expect(fetchAuthorized).toHaveBeenCalledOnce();
    const [forwardedRequest, actionContext] = fetchAuthorized.mock.calls[0]!;
    assert.instanceOf(forwardedRequest, Request);
    assert.equal(new URL(forwardedRequest.url).pathname, "/api/pi-manager/sessions");
    await expect(forwardedRequest.clone().json()).resolves.toMatchObject({
      actors: execution.actors,
    });
    expect(actionContext).toEqual({ execution, propagationContext: null });
  });

  test("opens the durable agent NDJSON stream through authorized PI_MANAGER fetch", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"snapshot","view":{}}\n'));
        controller.close();
      },
    });
    const fetchAuthorized = vi.fn(
      async (_request: Request, _actionContext: unknown) => new Response(stream),
    );
    const context = {
      get: () => ({
        runtime: { objects: { piManager: {} } },
        kernel: { scoped: () => ({ http: { fetchAuthorized } }) },
      }),
    };
    const request = new Request("https://backoffice.example/sessions/session-1/view-stream");

    const response = await fetchPiManagerSessionViewStream(
      request,
      context as never,
      scope,
      "session-1",
    );

    await expect(response.text()).resolves.toBe('{"type":"snapshot","view":{}}\n');
    const [forwardedRequest, actionContext] = fetchAuthorized.mock.calls[0]!;
    assert.equal(
      new URL(forwardedRequest.url).pathname,
      "/api/pi-manager/sessions/session-1/view-stream",
    );
    assert.equal(forwardedRequest.headers.get("accept"), "application/x-ndjson");
    expect(actionContext).toEqual({ execution, propagationContext: null });
  });

  test("submits prompts through the durable agent endpoint", async () => {
    const fetchAuthorized = vi.fn(async (_request: Request, _actionContext: unknown) =>
      Response.json({ submissionId: 7, requestId: "request-1" }, { status: 202 }),
    );
    const context = {
      get: () => ({
        runtime: { objects: { piManager: {} } },
        kernel: { scoped: () => ({ http: { fetchAuthorized } }) },
      }),
    };

    await expect(
      submitPiManagerPrompt(
        new Request("https://backoffice.example/sessions", { method: "POST" }),
        context as never,
        scope,
        "session-1",
        { requestId: "request-1", content: "Hello", whenBusy: "followUp" },
      ),
    ).resolves.toEqual({ requestId: "request-1", error: null });

    const [forwardedRequest] = fetchAuthorized.mock.calls[0]!;
    assert.equal(
      new URL(forwardedRequest.url).pathname,
      "/api/pi-manager/sessions/session-1/prompts",
    );
  });
});
