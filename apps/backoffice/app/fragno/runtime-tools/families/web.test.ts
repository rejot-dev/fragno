import { describe, expect, test, vi } from "vitest";

import {
  createTrustedSystemBackofficeToolContext,
  type BackofficeToolContext,
} from "../runtime-tools";
import { webRuntimeTools, type WebRuntime } from "./web";

const createRuntime = (): WebRuntime => ({
  extract: vi.fn(async (input) => ({
    action: input.action,
    result: "Example",
  })) as WebRuntime["extract"],
});

describe("web runtime tools", () => {
  test.each(["content", "markdown"] as const)("supports the %s action", (action) => {
    expect(
      webRuntimeTools[0].adapters!.bash!.parse([
        "--action",
        action,
        "--input-json",
        '{"url":"https://example.com"}',
      ]),
    ).toEqual({ action, input: { url: "https://example.com" } });
  });

  test("rejects unsupported Browser Run extract actions", () => {
    expect(() =>
      webRuntimeTools[0].adapters!.bash!.parse([
        "--action",
        "json",
        "--input-json",
        '{"url":"https://example.com"}',
      ]),
    ).toThrow();
  });

  test("delegates extraction to the web runtime", async () => {
    const runtime = createRuntime();
    const context: BackofficeToolContext<{ web: WebRuntime }> =
      createTrustedSystemBackofficeToolContext({ runtimes: { web: runtime } });
    const input = {
      action: "markdown" as const,
      input: { url: "https://example.com" },
    };

    await expect(webRuntimeTools[0].execute(input, context)).resolves.toEqual({
      action: "markdown",
      result: "Example",
    });
    expect(runtime.extract).toHaveBeenCalledWith(input);
  });
});
