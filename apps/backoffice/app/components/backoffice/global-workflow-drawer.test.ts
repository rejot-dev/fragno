import { assert, describe, test } from "vitest";

import { workflowRunErrorText } from "./global-workflow-drawer-utils";

describe("workflowRunErrorText", () => {
  test("includes the workflow error name and message", () => {
    assert.equal(
      workflowRunErrorText({
        errorName: "TypeError",
        errorMessage: "Cannot read properties of undefined (reading 'kind')",
      }),
      "TypeError: Cannot read properties of undefined (reading 'kind')",
    );
  });

  test("uses whichever workflow error field was persisted", () => {
    assert.equal(
      workflowRunErrorText({ errorName: null, errorMessage: "Execution failed" }),
      "Execution failed",
    );
    assert.equal(
      workflowRunErrorText({ errorName: "NonRetryableError", errorMessage: null }),
      "NonRetryableError",
    );
    assert.equal(workflowRunErrorText({ errorName: null, errorMessage: null }), null);
  });
});
