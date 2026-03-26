import { describe, expect, test } from "vitest";

import { parseAutomationLoadError, type AutomationLoadErrorDetails } from "./shared";

describe("parseAutomationLoadError", () => {
  test("extracts missing script details from catalog errors", () => {
    const error =
      "Automation script for binding 'telegram-file-store' '/workspace/automations/scripts/telegram-file-store.sh' was not found in the automation workspace: File not found.";

    const parsed = parseAutomationLoadError(error);

    expect(parsed).toMatchObject({
      kind: "missing-script",
      bindingId: "telegram-file-store",
      scriptPath: "/workspace/automations/scripts/telegram-file-store.sh",
      cause: "File not found.",
    } satisfies AutomationLoadErrorDetails);
  });

  test("returns generic details for unknown messages", () => {
    const error = "Some unrelated backend error";
    const parsed = parseAutomationLoadError(error);

    expect(parsed).toMatchObject({
      kind: "generic",
      message: error,
    } satisfies AutomationLoadErrorDetails);
  });
});
