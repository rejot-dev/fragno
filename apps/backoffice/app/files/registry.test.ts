import { describe, expect, test } from "vitest";

import {
  getRegisteredFileContributor,
  getRegisteredFileContributors,
  registerFileContributor,
  resetFileContributorsForTest,
} from "./registry";

describe("file contributor registry", () => {
  test("rejects empty contributor ids", () => {
    resetFileContributorsForTest();

    expect(() =>
      registerFileContributor({
        id: "   ",
        kind: "custom",
        mountPoint: "/workspace",
        title: "Workspace",
        readOnly: false,
        persistence: "session",
      }),
    ).toThrow("File contributor id cannot be empty.");
  });

  test("rejects duplicate contributor ids, trims stored ids, and normalizes mount points", () => {
    resetFileContributorsForTest();

    registerFileContributor({
      id: " workspace ",
      kind: "custom",
      mountPoint: "workspace",
      title: "Workspace",
      readOnly: false,
      persistence: "session",
    });

    expect(getRegisteredFileContributor("workspace")?.id).toBe("workspace");
    expect(getRegisteredFileContributor("workspace")?.mountPoint).toBe("/workspace");
    expect(getRegisteredFileContributors().map((contributor) => contributor.id)).toEqual([
      "workspace",
    ]);

    expect(() =>
      registerFileContributor({
        id: "workspace",
        kind: "custom",
        mountPoint: "/workspace-2",
        title: "Workspace",
        readOnly: false,
        persistence: "session",
      }),
    ).toThrow("File contributor 'workspace' is already registered.");
  });
});
