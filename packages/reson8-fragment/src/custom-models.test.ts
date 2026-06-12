import { describe, expect, test, assert } from "vitest";

import { createJsonResponse, createReson8TestContext, readRequestText } from "./test-context";

describe("reson8 custom model routes", () => {
  test("lists custom models and forwards the incoming Authorization header upstream", async () => {
    const ctx = createReson8TestContext();
    ctx.fetchMock.mockResolvedValue(
      createJsonResponse([
        {
          id: "model_123",
          name: "Cardiology",
          description: "Cardiology-specific terminology",
          phraseCount: 3,
        },
      ]),
    );

    const response = await ctx.fragment.callRoute("GET", "/custom-model", {
      headers: { Authorization: "Bearer token_123" },
    } as never);

    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = ctx.fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);

    expect(url).toBe("https://api.reson8.dev/v1/custom-model");
    assert(init?.method === "GET");
    assert(headers.get("authorization") === "Bearer token_123");

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    expect(response.data).toEqual([
      {
        id: "model_123",
        name: "Cardiology",
        description: "Cardiology-specific terminology",
        phraseCount: 3,
      },
    ]);
  });

  test("creates a custom model with a JSON request body and returns the upstream 201 payload", async () => {
    const ctx = createReson8TestContext();
    ctx.fetchMock.mockResolvedValue(
      createJsonResponse(
        {
          id: "model_456",
          name: "Neurology",
          description: "Neurology-specific terminology",
          phraseCount: 2,
        },
        { status: 201 },
      ),
    );

    const response = await ctx.fragment.callRoute("POST", "/custom-model", {
      body: {
        name: "Neurology",
        description: "Neurology-specific terminology",
        phrases: ["glioblastoma", "aphasia"],
      },
    } as never);

    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = ctx.fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);

    expect(url).toBe("https://api.reson8.dev/v1/custom-model");
    assert(init?.method === "POST");
    assert(headers.get("content-type") === "application/json");
    expect(await readRequestText(init)).toBe(
      JSON.stringify({
        name: "Neurology",
        description: "Neurology-specific terminology",
        phrases: ["glioblastoma", "aphasia"],
      }),
    );

    assert(response.type === "json");
    if (response.type !== "json") {
      return;
    }

    assert(response.status === 201);
    expect(response.data).toEqual({
      id: "model_456",
      name: "Neurology",
      description: "Neurology-specific terminology",
      phraseCount: 2,
    });
  });

  test("passes through structured upstream NOT_FOUND errors for custom model detail", async () => {
    const ctx = createReson8TestContext();
    ctx.fetchMock.mockResolvedValue(
      createJsonResponse(
        {
          code: "NOT_FOUND",
          message: "Custom model not found",
        },
        { status: 404 },
      ),
    );

    const response = await ctx.fragment.callRoute("GET", "/custom-model/:id", {
      pathParams: { id: "missing-model" },
    } as never);

    assert(response.type === "error");
    if (response.type !== "error") {
      return;
    }

    assert(response.status === 404);
    expect(response.error).toEqual({
      code: "NOT_FOUND",
      message: "Custom model not found",
    });
  });
});
