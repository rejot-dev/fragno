import { describe, expect, test } from "vitest";

import { automationRunResultSchema, createAutomationRunResult } from "./run-result";

describe("automation run result", () => {
  test("preserves workflow definitions through runtime-tool output validation", () => {
    const result = createAutomationRunResult({
      runtime: "codemode",
      eventId: "event-1",
      scriptId: "script-1",
      exitCode: 0,
      workflowDefinition: { name: "script-local-name", options: { name: "script-local-name" } },
    });

    expect(automationRunResultSchema.parse(result)).toMatchObject({
      workflowDefinition: { name: "script-local-name", options: { name: "script-local-name" } },
    });
  });
});
