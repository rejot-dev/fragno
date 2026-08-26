import { assert, describe, test } from "vitest";

import { toAutomationScriptIdFromAbsolutePath } from "./script-records";

describe("automation script records", () => {
  test("creates a safe script id from an absolute automation path", () => {
    assert(
      toAutomationScriptIdFromAbsolutePath("/workspace/automations/reminder.workflow.js") ===
        "automation-script:workspace:reminder.workflow.js",
    );
  });
});
