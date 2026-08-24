import { describe, expect, test } from "vitest";

import { marketplaceOwnerForOrganization } from "./publisher.server";

const me = {
  user: { id: "user-1" },
  organizations: [
    { organization: { id: "org-1", slug: "acme", name: "Acme" } },
    { organization: { id: "org-2", name: "Beta" } },
  ],
} as never;

describe("marketplace owner boundary", () => {
  test("derives organization ownership only from an existing membership", () => {
    expect(marketplaceOwnerForOrganization(me, "org-2")).toEqual({
      scope: { kind: "org", orgId: "org-2" },
      publisherName: "Beta",
    });
    expect(marketplaceOwnerForOrganization(me, "org-other")).toBeNull();
  });
});
