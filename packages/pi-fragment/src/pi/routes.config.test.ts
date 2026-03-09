import { describe, expect, it, vi } from "vitest";

import { PiLogger } from "../debug-log";
import { buildHarness, createStreamFn, mockModel } from "./test-utils";
import type { PiFragmentConfig, PiWorkflowsService } from "./types";

describe("pi-fragment config requirements", () => {
  it("requires workflows service at instantiation", async () => {
    const config = {
      agents: {},
      tools: {},
    } as PiFragmentConfig;

    await expect(
      buildHarness(config, {
        wrapWorkflowsService: () => undefined as unknown as PiWorkflowsService,
      }),
    ).rejects.toThrow("requires service 'workflows'");
  });

  it("resets logger state when logging config is omitted", async () => {
    PiLogger.enable();
    PiLogger.setLogLevel("debug");

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const config: PiFragmentConfig = {
      agents: {
        default: {
          name: "default",
          systemPrompt: "You are helpful.",
          model: mockModel,
          streamFn: createStreamFn("assistant:logger"),
        },
      },
      tools: {},
    };

    const harness = await buildHarness(config);

    try {
      PiLogger.debug("should-not-log");
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      await harness.test.cleanup();
    }
  });
});
