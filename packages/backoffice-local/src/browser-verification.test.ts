import { describe, expect, test } from "vitest";

import { resolveBackofficeVerificationBrowserCommand } from "./browser-verification.js";

describe("Backoffice verification browser command", () => {
  test.each(["file:///tmp/verification", "javascript:alert(1)", "not a URL"])(
    "rejects %s",
    (verificationUrl) => {
      expect(resolveBackofficeVerificationBrowserCommand(verificationUrl, "linux")).toBeNull();
    },
  );

  test("opens Windows verification URLs without cmd.exe parsing", () => {
    expect(
      resolveBackofficeVerificationBrowserCommand(
        "https://backoffice.example/device?user_code=ONE&TWO",
        "win32",
      ),
    ).toEqual(["explorer.exe", ["https://backoffice.example/device?user_code=ONE&TWO"]]);
  });

  test.each([
    ["darwin" as const, "open"],
    ["linux" as const, "xdg-open"],
  ])("uses the platform browser command on %s", (platform, expectedCommand) => {
    expect(
      resolveBackofficeVerificationBrowserCommand("https://backoffice.example/device", platform),
    ).toEqual([expectedCommand, ["https://backoffice.example/device"]]);
  });
});
