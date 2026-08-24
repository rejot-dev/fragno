import { describe, expect, test } from "vitest";

import {
  getOrganizationPreferenceState,
  sortOrganizationsByPreference,
} from "./organizations-preference";

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

  test("marks the current preferred organization and hides the set-default action", () => {
    expect(getOrganizationPreferenceState("org-a", "org-a")).toEqual({
      isPreferred: true,
      badgeLabel: "Preferred",
      actionLabel: "Preferred org",
      canSwitch: false,
    });

    expect(getOrganizationPreferenceState("org-b", "org-a")).toEqual({
      isPreferred: false,
      badgeLabel: "Available",
      actionLabel: "Switch here",
      canSwitch: true,
    });
  });
});
