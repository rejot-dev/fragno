import { describe, expect, test } from "vitest";

import { buildAutomationWorkflowInstanceId } from "./definition";

describe("buildAutomationWorkflowInstanceId", () => {
  test("uses double hyphens instead of colons", () => {
    expect(
      buildAutomationWorkflowInstanceId(
        "telegram:dxmrdoe5vkwxmrdoe5vkwxmr:504243579:129626722:329",
        "telegram-claim-linking-start",
      ),
    ).toBe(
      "telegram--dxmrdoe5vkwxmrdoe5vkwxmr--504243579--129626722--329--telegram-claim-linking-start",
    );
  });
});
