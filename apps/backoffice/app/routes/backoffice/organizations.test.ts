import { describe, expect, test } from "vitest";

import { sortOrganizationsByPreference } from "./organizations-preference";

describe("Backoffice organizations preferred-org helpers", () => {
  test("sorts the preferred organization to the front of the list", () => {
    const organizations = [
      { organization: { id: "org-a", name: "Org A" } },
      { organization: { id: "org-b", name: "Org B" } },
      { organization: { id: "org-c", name: "Org C" } },
    ];

    const sorted = sortOrganizationsByPreference(organizations, "org-b");

    expect(sorted.map((entry) => entry.organization.id)).toEqual(["org-b", "org-a", "org-c"]);
  });
});
