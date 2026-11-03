import { describe, expect, test } from "vitest";

import { loadUniverseMemberNames } from "./orchestration-loader.server";

/** A request context whose Auth object lists members with `listMembers`. */
function contextListing(listMembers: () => Promise<unknown>) {
  const auth = { singleton: () => ({ commands: { listOrganizationMembersByPage: listMembers } }) };
  return { get: () => ({ runtime: { objects: { auth } } }) } as never;
}

describe("the names the universe gives members' planets", () => {
  test("are their names, or their emails without one", async () => {
    const context = contextListing(async () => ({
      members: [
        { userId: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
        { userId: "user-2", name: "", email: "grace@example.com" },
      ],
      total: 2,
    }));

    expect(await loadUniverseMemberNames(context, "org-1")).toEqual({
      names: { "user-1": "Ada Lovelace", "user-2": "grace@example.com" },
      problems: [],
    });
  });

  test("say why nobody is named when the directory does not answer", async () => {
    const context = contextListing(async () => {
      throw new Error("Auth is unavailable.");
    });

    expect(await loadUniverseMemberNames(context, "org-1")).toEqual({
      names: {},
      problems: [
        "Members' names could not be read, so their planets go by their scopes: Auth is unavailable.",
      ],
    });
  });
});
