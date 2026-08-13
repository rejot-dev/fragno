import { assert, describe, test } from "vitest";

import { scopeSwitchPath } from "./scope-switch-path";

const projectScope = { kind: "project" as const, orgId: "org-a", projectId: "proj-1" };

describe("scopeSwitchPath", () => {
  test.each([
    ["/backoffice/automations", "/backoffice/automations/project/org-a%3Aproj-1/dashboard"],
    ["/backoffice/sessions", "/backoffice/sessions/project/org-a%3Aproj-1/sessions"],
    ["/backoffice/files", "/backoffice/files/project/org-a%3Aproj-1"],
    ["/backoffice/marketplace", "/backoffice/marketplace/project/org-a%3Aproj-1/marketplace"],
  ])("carries the scope into the section root %s", (pathname, expectedPath) => {
    assert(scopeSwitchPath(pathname, projectScope) === expectedPath);
  });

  test("keeps a scope-independent automation tab", () => {
    assert(
      scopeSwitchPath("/backoffice/automations/org/org-a/scripts", projectScope) ===
        "/backoffice/automations/project/org-a%3Aproj-1/scripts",
    );
  });

  test("falls back from a system-unavailable automation tab", () => {
    assert(
      scopeSwitchPath("/backoffice/automations/org/org-a/api", { kind: "system" }) ===
        "/backoffice/automations/system/system/scripts",
    );
  });

  test("lands unknown sections on the automations dashboard", () => {
    assert(
      scopeSwitchPath("/backoffice/organisations", projectScope) ===
        "/backoffice/automations/project/org-a%3Aproj-1/dashboard",
    );
  });
});
