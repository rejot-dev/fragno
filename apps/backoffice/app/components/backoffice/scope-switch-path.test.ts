import { assert, describe, test } from "vitest";

import { scopeSwitchPath } from "./scope-switch-path";

const projectScope = { kind: "project" as const, orgSlug: "org-a", projectId: "proj-1" };

describe("scopeSwitchPath", () => {
  test.each([
    ["/backoffice/automations", "/backoffice/automations/project/org-a%3Aproj-1/orchestration"],
    ["/backoffice/sessions", "/backoffice/sessions/project/org-a%3Aproj-1/sessions"],
    ["/backoffice/computers", "/backoffice/computers/project/org-a%3Aproj-1/sandboxes"],
    ["/backoffice/files", "/backoffice/files/project/org-a%3Aproj-1"],
    ["/backoffice/marketplace", "/backoffice/marketplace/project/org-a%3Aproj-1/marketplace"],
    ["/backoffice/internals", "/backoffice/internals/project/org-a%3Aproj-1"],
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
          "/backoffice/automations/project/org-a%3Aproj-1/orchestration",
      );
    },
  );

  test("lands the system scope on the computers index instead of a computer kind", () => {
    assert(
      scopeSwitchPath("/backoffice/computers/org/org-a/sandboxes/sbx-1", { kind: "system" }) ===
        "/backoffice/computers/system/system",
    );
  });

  test("switches the scope used by the durable hooks inspector", () => {
    assert(
      scopeSwitchPath("/backoffice/internals/org/org-a/durable-hooks/api/hook-1", projectScope) ===
        "/backoffice/internals/project/org-a%3Aproj-1/durable-hooks/api",
    );
  });

  test("switches the scope used by the workflows inspector", () => {
    assert(
      scopeSwitchPath(
        "/backoffice/internals/org/org-a/workflows/example/instance-1",
        projectScope,
      ) === "/backoffice/internals/project/org-a%3Aproj-1/workflows",
    );
  });

  test("switches the scope while keeping an internals tool", () => {
    assert(
      scopeSwitchPath("/backoffice/internals/org/org-a/users", projectScope) ===
        "/backoffice/internals/project/org-a%3Aproj-1/users",
    );
  });

  test("lands unknown sections on automations orchestration", () => {
    assert(
      scopeSwitchPath("/backoffice/organizations", projectScope) ===
        "/backoffice/automations/project/org-a%3Aproj-1/orchestration",
    );
  });
});
