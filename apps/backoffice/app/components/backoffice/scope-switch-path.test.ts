import { assert, describe, test } from "vitest";

import { scopeSwitchPath } from "./scope-switch-path";

const projectScope = { kind: "project" as const, orgSlug: "org-a", projectId: "proj-1" };

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
      scopeSwitchPath("/backoffice/automations/org/org-a/store", projectScope) ===
        "/backoffice/automations/project/org-a%3Aproj-1/store",
    );
  });

  test.each(["scripts", "router", "events"])(
    "falls back from removed automation tab %s",
    (removedTab) => {
      assert(
        scopeSwitchPath(`/backoffice/automations/org/org-a/${removedTab}`, projectScope) ===
          "/backoffice/automations/project/org-a%3Aproj-1/dashboard",
      );
    },
  );

  test("falls back from a system-unavailable automation tab", () => {
    assert(
      scopeSwitchPath("/backoffice/automations/org/org-a/api", { kind: "system" }) ===
        "/backoffice/automations/system/system/dashboard",
    );
  });

  test("switches the scope used by the durable hooks inspector", () => {
    assert(
      scopeSwitchPath("/backoffice/internals/durable-hooks/org/org-a/api/hook-1", projectScope) ===
        "/backoffice/internals/durable-hooks/project/org-a%3Aproj-1/api",
    );
  });

  test("switches the scope used by the workflows inspector", () => {
    assert(
      scopeSwitchPath(
        "/backoffice/internals/workflows/org/org-a/example/instance-1",
        projectScope,
      ) === "/backoffice/internals/workflows/project/org-a%3Aproj-1",
    );
  });

  test("keeps unscoped internals tools in place", () => {
    assert(
      scopeSwitchPath("/backoffice/internals/users", projectScope) ===
        "/backoffice/internals/users",
    );
  });

  test("lands unknown sections on the automations dashboard", () => {
    assert(
      scopeSwitchPath("/backoffice/organizations", projectScope) ===
        "/backoffice/automations/project/org-a%3Aproj-1/dashboard",
    );
  });
});
