import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { authorizeBackofficeContextMock, formsFetchMock, getFormsDurableObjectMock } = vi.hoisted(
  () => ({
    authorizeBackofficeContextMock: vi.fn(),
    formsFetchMock: vi.fn(),
    getFormsDurableObjectMock: vi.fn(),
  }),
);

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  authorizeBackofficeContext: authorizeBackofficeContextMock,
}));

vi.mock("@/worker-runtime/durable-objects", () => ({
  getFormsDurableObject: getFormsDurableObjectMock,
}));

import { action, loader } from "./forms";

const context = {} as never;

function callFormsRoute(request: Request) {
  const routeHandler = request.method === "GET" ? loader : action;
  return routeHandler({ request, context, params: {} } as never);
}

beforeEach(() => {
  authorizeBackofficeContextMock.mockReset();
  formsFetchMock.mockReset();
  getFormsDurableObjectMock.mockReset();

  authorizeBackofficeContextMock.mockResolvedValue({ ok: true, headers: [] });
  formsFetchMock.mockResolvedValue(new Response("forwarded"));
  getFormsDurableObjectMock.mockReturnValue({ http: { fetch: formsFetchMock } });
});

describe("Forms API authorization", () => {
  test.each([
    ["https://backoffice.test/api/forms/waitlist", "GET"],
    ["https://backoffice.test/api/forms/waitlist/submit", "POST"],
    ["https://backoffice.test/api/forms/admin", "GET"],
    ["https://backoffice.test/api/forms/admin/submit", "POST"],
  ])(
    "forwards the public Forms fragment route %s without authorization",
    async (requestUrl, method) => {
      const request = new Request(requestUrl, { method });

      const response = await callFormsRoute(request);

      assert.equal(response.status, 200);
      expect(authorizeBackofficeContextMock).not.toHaveBeenCalled();
      expect(formsFetchMock).toHaveBeenCalledWith(request);
    },
  );

  test.each([
    ["https://backoffice.test/api/forms/admin/forms", "GET"],
    ["https://backoffice.test/api/forms/admin/forms/form_123/submissions", "GET"],
    ["https://backoffice.test/api/forms/admin/submissions/response_123", "DELETE"],
  ])("rejects anonymous access to %s before forwarding", async (requestUrl, method) => {
    authorizeBackofficeContextMock.mockResolvedValue({
      ok: false,
      response: new Response("Unauthorized", { status: 401 }),
    });
    const request = new Request(requestUrl, { method });

    const response = await callFormsRoute(request);

    assert.equal(response.status, 401);
    expect(authorizeBackofficeContextMock).toHaveBeenCalledWith(request, context, {
      kind: "system",
    });
    expect(formsFetchMock).not.toHaveBeenCalled();
  });

  test("forwards authorized administration requests and preserves authorization headers", async () => {
    authorizeBackofficeContextMock.mockResolvedValue({
      ok: true,
      headers: [["x-backoffice-authorization", "granted"]],
    });
    const request = new Request("https://backoffice.test/api/forms/admin/forms", {
      method: "POST",
    });

    const response = await callFormsRoute(request);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-backoffice-authorization"), "granted");
    expect(formsFetchMock).toHaveBeenCalledWith(request);
  });
});
