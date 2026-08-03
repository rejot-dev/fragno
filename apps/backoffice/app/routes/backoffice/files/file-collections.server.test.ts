import { describe, expect, test } from "vitest";

import { filesOverviewRootPathsForScope } from "./file-collections.server";

describe("Files overview roots", () => {
  test("shows only system files in system scope", () => {
    expect(filesOverviewRootPathsForScope({ kind: "system" })).toEqual(["/system"]);
  });

  test("shows static and workspace files in organisation scope", () => {
    expect(filesOverviewRootPathsForScope({ kind: "org", orgId: "org-1" })).toEqual([
      "/static",
      "/workspace",
    ]);
  });

  test.each([
    { kind: "user" as const, userId: "user-1" },
    { kind: "project" as const, orgId: "org-1", projectId: "project-1" },
  ])("shows only workspace files in $kind scope", (scope) => {
    expect(filesOverviewRootPathsForScope(scope)).toEqual(["/workspace"]);
  });
});
