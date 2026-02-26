import { describe, expect, it } from "vitest";

import { buildHarness } from "./test-utils";
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
});
