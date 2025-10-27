import { describe, it, expect, assert } from "vitest";
import { createFragmentForTest } from "@fragno-dev/core/test";
import { chatnoDefinition, routes } from "./index";

describe("chatno", () => {
  const fragment = createFragmentForTest(chatnoDefinition, {
    config: {
      openaiApiKey: "test-key",
    },
  });

  const [, healthRoute, simpleStreamRoute] = fragment.initRoutes(routes);

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
    const response = await fragment.handler(simpleStreamRoute);

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
    const response = await fragment.handler(healthRoute);

    assert(response.type === "json");
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ status: "ok" });
  });
});
