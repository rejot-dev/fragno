import { describe, expect, test } from "vitest";

import { toCfSandboxPath } from "./cf-sandbox-path";

describe("CF Sandbox path builder", () => {
  test("builds sandbox links without an explicit organization scope", () => {
    expect(toCfSandboxPath({})).toBe("/backoffice/environments/cf-sandbox");
    expect(toCfSandboxPath({ view: "new" })).toBe("/backoffice/environments/cf-sandbox?view=new");
    expect(toCfSandboxPath({ view: "detail", sandboxId: "sandbox-1" })).toBe(
      "/backoffice/environments/cf-sandbox?sandbox=sandbox-1",
    );
  });
});
