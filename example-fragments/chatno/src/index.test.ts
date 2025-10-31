import { describe, it, expect, assert } from "vitest";
import { createFragmentForTest } from "@fragno-dev/core/test";
import { chatnoDefinition, healthRoute, simpleStreamRoute } from "./index";
import { chatRouteFactory } from "./server/chatno-api";

describe("chatno", () => {
  const routes = [chatRouteFactory, healthRoute, simpleStreamRoute] as const;
  const fragment = createFragmentForTest(chatnoDefinition, routes, {
    config: {
      openaiApiKey: "test-key",
    },
  });

  // Test with just healthRoute
  const fragmentJustHealth = createFragmentForTest(chatnoDefinition, [healthRoute] as const, {
    config: {
      openaiApiKey: "test-key",
    },
  });

  // Test with just a factory
  const fragmentJustFactory = createFragmentForTest(
    chatnoDefinition,
    [simpleStreamRoute] as const,
    {
      config: {
        openaiApiKey: "test-key",
      },
    },
  );

  it("services - should return OpenAI URL from getOpenAIURL service", () => {
    const openaiURL = fragment.services.getOpenAIURL();

    expect(openaiURL).toBe("https://api.openai.com/v1");
  });

  it("services - should return simple stream", async () => {
    const collected = await Array.fromAsync(fragment.services.generateStreamMessages());
    expect(collected).toEqual([
      { message: "Item 1" },
      { message: "Item 2" },
      { message: "Item 3" },
      { message: "Item 4" },
      { message: "Item 5" },
      { message: "Item 6" },
      { message: "Item 7" },
      { message: "Item 8" },
      { message: "Item 9" },
      { message: "Item 10" },
    ]);
  });

  it("routes - should return simple stream", async () => {
    const response = await fragment.callRoute("GET", "/simple-stream");

    assert(response.type === "jsonStream");
    const items = [];
    for await (const item of response.stream) {
      items.push(item);
    }

    expect(items).toEqual([
      { message: "Item 1" },
      { message: "Item 2" },
      { message: "Item 3" },
      { message: "Item 4" },
      { message: "Item 5" },
      { message: "Item 6" },
      { message: "Item 7" },
      { message: "Item 8" },
      { message: "Item 9" },
      { message: "Item 10" },
    ]);
  });

  it("routes - should test health route", async () => {
    const response = await fragment.callRoute("GET", "/health");

    assert(response.type === "json");
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ status: "ok" });
  });

  it("routes - should test health route with simple fragment", async () => {
    const response = await fragmentJustHealth.callRoute("GET", "/health");

    assert(response.type === "json");
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ status: "ok" });
  });

  it("routes - should test simple stream with factory fragment", async () => {
    const response = await fragmentJustFactory.callRoute("GET", "/simple-stream");

    assert(response.type === "jsonStream");
    expect(response.status).toBe(200);
  });
});
