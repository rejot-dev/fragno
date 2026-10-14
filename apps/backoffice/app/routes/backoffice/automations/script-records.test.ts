import { assert, describe, test } from "vitest";

import { fromAutomationScriptId, toAutomationScriptIdFromAbsolutePath } from "./script-records";

describe("automation script records", () => {
  test("round-trips scripts installed outside the workspace automations folder", () => {
    const path = "/workspace/telegram-channel/automations/telegram-user-linking.workflow.js";
    assert.equal(fromAutomationScriptId(toAutomationScriptIdFromAbsolutePath(path)), path);
  });
});
