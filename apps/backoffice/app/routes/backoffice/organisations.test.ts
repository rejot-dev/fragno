import { describe, expect, test } from "vitest";

import {
  getOrganizationPreferenceState,
  sortOrganizationsByDefault,
} from "./organisations-preference";

describe("Backoffice organisations default-org helpers", () => {
  test("sorts the default organization to the front of the list", () => {
    const organizations = [
      { organization: { id: "org-a", name: "Org A" } },
      { organization: { id: "org-b", name: "Org B" } },
      { organization: { id: "org-c", name: "Org C" } },
    ];

    const sorted = sortOrganizationsByDefault(organizations, "org-b");

    expect(sorted.map((entry) => entry.organization.id)).toEqual(["org-b", "org-a", "org-c"]);
  });

  test("marks the current default organization and hides the set-default action", () => {
    expect(getOrganizationPreferenceState("org-a", "org-a")).toEqual({
      isDefault: true,
      badgeLabel: "Default",
      actionLabel: "Default org",
      canSetDefault: false,
    });

    expect(getOrganizationPreferenceState("org-b", "org-a")).toEqual({
      isDefault: false,
      badgeLabel: "Available",
      actionLabel: "Set default",
      canSetDefault: true,
    });
  });
});
