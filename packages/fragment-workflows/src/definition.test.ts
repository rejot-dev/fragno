import { describe, expect, test } from "vitest";

import { z } from "zod";

import { validateWorkflowParams } from "./definition";

describe("validateWorkflowParams", () => {
  test("rejects invalid params for registry entries with workflow metadata", async () => {
    const workflowsByName = new Map([
      [
        "schema-workflow",
        {
          schema: z.object({ source: z.string() }),
          workflow: {},
        },
      ],
    ]);

    await expect(
      validateWorkflowParams(workflowsByName, "schema-workflow", { source: 123 }),
    ).rejects.toThrow("WORKFLOW_PARAMS_INVALID");
  });
});
