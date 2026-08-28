import { assert, describe, expect, test, vi } from "vitest";

import type {
  AutomationsObject,
  BackofficeActionRpcContext,
  BackofficeObjectHandle,
} from "@/backoffice-runtime/object-registry";

import { createRouteBackedAutomationStoreRuntime } from "./bindings-route-runtime";
import { createAutomationsRouteCaller } from "./route-callers";

const execution = {
  scope: { kind: "org", orgId: "org-1" } as const,
  actors: {
    initiator: {
      scope: "external" as const,
      source: "telegram",
      type: "chat",
      id: "chat-1",
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

function automationsHandle(
  fetchAuthorized: (request: Request, context: BackofficeActionRpcContext) => Promise<Response>,
  fetch: (request: Request) => Promise<Response>,
): BackofficeObjectHandle<AutomationsObject> {
  return {
    commands: {} as AutomationsObject,
    http: { fetch, fetchAuthorized },
  };
}

describe("createAutomationsRouteCaller", () => {
  test("passes every route through authorized HTTP when execution is supplied", async () => {
    const fetchAuthorized = vi.fn(async (_request: Request, _context: BackofficeActionRpcContext) =>
      Response.json({ id: "project-1" }),
    );
    const fetch = vi.fn(async () => new Response());
    const callRoute = createAutomationsRouteCaller({
      object: automationsHandle(fetchAuthorized, fetch),
      context: { execution },
    });

    await expect(
      callRoute("POST", "/projects", {
        body: { name: "Example", createdByUserId: "user-1" },
      }),
    ).resolves.toMatchObject({ type: "json", data: { id: "project-1" } });

    expect(fetchAuthorized).toHaveBeenCalledOnce();
    const [request, context] = fetchAuthorized.mock.calls[0];
    expect(new URL(request.url)).toMatchObject({
      pathname: "/api/automations/projects",
    });
    assert(request.method === "POST");
    await expect(request.json()).resolves.toEqual({
      name: "Example",
      createdByUserId: "user-1",
    });
    expect(context).toEqual({ execution });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("createRouteBackedAutomationStoreRuntime", () => {
  test("sends store mutations through authorized HTTP", async () => {
    const fetchAuthorized = vi.fn(async (_request: Request, _context: BackofficeActionRpcContext) =>
      Response.json({
        id: "store-1",
        key: "ordinary/key",
        value: "value",
        description: null,
        category: ["ordinary"],
      }),
    );
    const fetch = vi.fn(async () => new Response());
    const runtime = createRouteBackedAutomationStoreRuntime({
      object: automationsHandle(fetchAuthorized, fetch),
      execution,
    });

    await expect(
      runtime.set({
        key: "ordinary/key",
        value: "value",
        category: ["ordinary"],
      }),
    ).resolves.toMatchObject({ key: "ordinary/key", value: "value" });

    expect(fetchAuthorized).toHaveBeenCalledOnce();
    const [request, context] = fetchAuthorized.mock.calls[0];
    assert(new URL(request.url).pathname === "/api/automations/store/set");
    await expect(request.json()).resolves.toEqual({
      key: "ordinary/key",
      value: "value",
      category: ["ordinary"],
    });
    expect(context).toEqual({ execution });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("preserves a missing delete response from authorized HTTP", async () => {
    const fetchAuthorized = vi.fn(async (_request: Request, _context: BackofficeActionRpcContext) =>
      Response.json(
        {
          message: "Store entry not found for missing/key.",
          code: "STORE_ENTRY_NOT_FOUND",
        },
        { status: 404 },
      ),
    );
    const fetch = vi.fn(async () => new Response());
    const runtime = createRouteBackedAutomationStoreRuntime({
      object: automationsHandle(fetchAuthorized, fetch),
      execution,
    });

    await expect(runtime.delete({ key: "missing/key" })).resolves.toBeNull();
    expect(fetchAuthorized).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
