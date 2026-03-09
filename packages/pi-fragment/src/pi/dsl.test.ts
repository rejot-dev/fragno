import { describe, expect, it, vi } from "vitest";

import { PiLogger } from "../debug-log";
import { createPi, defineAgent } from "./dsl";
import { mockModel } from "./test-utils";

describe("createPi builder", () => {
  it("propagates logging config to runtime config and workflow initialization", () => {
    const logging = { enabled: true, level: "debug" } as const;
    const resetSpy = vi.spyOn(PiLogger, "reset");
    const configureSpy = vi.spyOn(PiLogger, "configure");

    try {
      const runtime = createPi()
        .agent(
          defineAgent("default", {
            systemPrompt: "You are helpful.",
            model: mockModel,
          }),
        )
        .logging(logging)
        .build();

      expect(runtime.config.logging).toEqual(logging);
      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(configureSpy).toHaveBeenCalledWith(logging);
    } finally {
      configureSpy.mockRestore();
      resetSpy.mockRestore();
    }
  });
});
