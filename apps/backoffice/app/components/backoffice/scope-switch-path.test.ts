import { assert, describe, test } from "vitest";

import { scopeSwitchPath } from "./scope-switch-path";

const projectScope = {
  kind: "project" as const,
  owner: { kind: "org" as const, orgSlug: "org-a" },
  projectSlug: "proj-1",
};

describe("scopeSwitchPath", () => {
  test.each([
    ["/backoffice/dashboard", "/backoffice/dashboard/project/org:org-a:proj-1"],
    ["/backoffice/agents", "/backoffice/agents/project/org:org-a:proj-1/agents"],
    ["/backoffice/computers", "/backoffice/computers/project/org:org-a:proj-1/sandboxes"],
    ["/backoffice/files", "/backoffice/files/project/org:org-a:proj-1"],
    ["/backoffice/marketplace", "/backoffice/marketplace/project/org:org-a:proj-1/marketplace"],
    ["/backoffice/internals", "/backoffice/internals/project/org:org-a:proj-1"],
  ])("carries the scope into the section root %s", (pathname, expectedPath) => {
    assert(scopeSwitchPath(pathname, projectScope) === expectedPath);
  });

  test("lands the system scope on the computers index instead of a computer kind", () => {
    assert(
      scopeSwitchPath("/backoffice/computers/org/org-a/sandboxes/sbx-1", { kind: "system" }) ===
        "/backoffice/computers/system/system",
    );
  });

  test("switches the scope used by the durable hooks inspector", () => {
    assert(
      scopeSwitchPath("/backoffice/internals/org/org-a/durable-hooks/api/hook-1", projectScope) ===
        "/backoffice/internals/project/org:org-a:proj-1/durable-hooks/api",
    );
  });

  test("switches the scope used by the workflows inspector", () => {
    assert(
      scopeSwitchPath(
        "/backoffice/internals/org/org-a/workflows/example/instance-1",
        projectScope,
      ) === "/backoffice/internals/project/org:org-a:proj-1/workflows",
    );
  });

  test("switches the scope while keeping an internals tool", () => {
    assert(
      scopeSwitchPath("/backoffice/internals/org/org-a/users", projectScope) ===
        "/backoffice/internals/project/org:org-a:proj-1/users",
    );
  });

  test("lands unknown sections on the dashboard", () => {
    assert(
      scopeSwitchPath("/backoffice/claims/acme/complete", projectScope) ===
        "/backoffice/dashboard/project/org:org-a:proj-1",
    );
  });

  test("keeps settings open for the new scope's owner", () => {
    // An organization's settings keep the tabs every organization has.
    assert(
      scopeSwitchPath("/backoffice/organizations/org-b/members", {
        kind: "org",
        orgSlug: "org-a",
      }) === "/backoffice/organizations/org-a/members",
    );
    assert(
      scopeSwitchPath("/backoffice/organizations/org-b/invites", {
        kind: "org",
        orgSlug: "org-a",
      }) === "/backoffice/organizations/org-a",
    );
    assert(
      scopeSwitchPath("/backoffice/settings", { kind: "org", orgSlug: "org-a" }) ===
        "/backoffice/organizations/org-a",
    );
    // The user's own workspace opens their settings; a member's has none to open.
    assert(
      scopeSwitchPath("/backoffice/organizations/org-a", { kind: "user", userId: "ada" }, "ada") ===
        "/backoffice/settings",
    );
    // An organization's billing and the user's usage open each other.
    assert(
      scopeSwitchPath(
        "/backoffice/organizations/org-a/billing",
        { kind: "user", userId: "ada" },
        "ada",
      ) === "/backoffice/usage",
    );
    assert(
      scopeSwitchPath("/backoffice/usage", { kind: "org", orgSlug: "org-a" }) ===
        "/backoffice/organizations/org-a/billing",
    );
    assert(
      scopeSwitchPath("/backoffice/organizations", { kind: "user", userId: "cleo" }, "ada") ===
        "/backoffice/dashboard/user/cleo",
    );
    assert(
      scopeSwitchPath("/backoffice/settings", { kind: "system" }, "ada") ===
        "/backoffice/dashboard/system/system",
    );
  });
});
