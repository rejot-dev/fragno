import { describe, test, assert } from "vitest";

import { buildAutomationWorkflowInstanceId } from "./definition";

describe("buildAutomationWorkflowInstanceId", () => {
  test("uses double hyphens instead of colons", () => {
    assert(
      buildAutomationWorkflowInstanceId(
        "telegram:dxmrdoe5vkwxmrdoe5vkwxmr:504243579:129626722:329",
        "telegram-claim-linking-start",
      ) ===
        "telegram--dxmrdoe5vkwxmrdoe5vkwxmr--504243579--129626722--329--telegram-claim-linking-start",
    );
  });
});
