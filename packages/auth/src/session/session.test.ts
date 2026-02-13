import { describe, expect, it } from "vitest";
import { assertOrganizationServices } from "./session";

describe("session organization services guard", () => {
  it("throws when required organization services are missing", () => {
    expect(() => assertOrganizationServices({})).toThrow(/Missing organization services/);
  });

  it("passes when required organization services are present", () => {
    const services = {
      getOrganizationsForUser: () => ({ organizations: [], cursor: undefined, hasNextPage: false }),
      listOrganizationMemberRolesForMembers: () => ({ rolesByMemberId: {} }),
      listOrganizationInvitationsForUser: () => ({ invitations: [] }),
      getActiveOrganization: () => ({ organizationId: null }),
    };

    expect(() => assertOrganizationServices(services)).not.toThrow();
  });
});
