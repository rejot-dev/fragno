import { describe, expect, test } from "vitest";

import type { AutomationExecutionContext } from "@/fragno/automation/actors";

import {
  createBackofficeAuthorityResolver,
  type BackofficeMembershipDirectory,
} from "./authority-resolver";
import { BACKOFFICE_AUTHORITY_ROLE_GRANTS } from "./authority-roles";

class MemoryMembershipDirectory implements BackofficeMembershipDirectory {
  readonly #memberships = new Set<string>();

  add(organizationId: string, userId: string) {
    this.#memberships.add(`${organizationId}:${userId}`);
  }

  remove(organizationId: string, userId: string) {
    this.#memberships.delete(`${organizationId}:${userId}`);
  }

  async hasOrganizationMembership(input: { organizationId: string; userId: string }) {
    return this.#memberships.has(`${input.organizationId}:${input.userId}`);
  }
}

const principal = {
  scope: "internal" as const,
  type: "user",
  id: "user-1",
  role: "principal" as const,
};

const organizationExecution: AutomationExecutionContext = {
  scope: { kind: "org", orgId: "org-1" },
  actors: {
    initiator: {
      scope: "external",
      source: "telegram",
      type: "chat",
      id: "chat-1",
      role: "initiator",
    },
    principal,
    delegation: [],
  },
};

describe("createBackofficeAuthorityResolver", () => {
  test("re-evaluates current organization membership", async () => {
    const memberships = new MemoryMembershipDirectory();
    const resolver = createBackofficeAuthorityResolver(memberships);

    memberships.add("org-1", "user-1");
    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: organizationExecution,
      }),
    ).resolves.toEqual(BACKOFFICE_AUTHORITY_ROLE_GRANTS["organization-member"]);

    memberships.remove("org-1", "user-1");
    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: organizationExecution,
      }),
    ).resolves.toEqual([]);
  });

  test("grants user-scope authority only to that user", async () => {
    const resolver = createBackofficeAuthorityResolver(new MemoryMembershipDirectory());

    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: {
          scope: { kind: "user", userId: "user-1" },
          actors: organizationExecution.actors,
        },
      }),
    ).resolves.toEqual(BACKOFFICE_AUTHORITY_ROLE_GRANTS["user-owner"]);

    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: {
          scope: { kind: "user", userId: "user-2" },
          actors: organizationExecution.actors,
        },
      }),
    ).resolves.toEqual([]);
  });

  test("grants capabilities only to trusted internal runtime actors", async () => {
    const resolver = createBackofficeAuthorityResolver(new MemoryMembershipDirectory());

    await expect(
      resolver.resolveActorCapabilityGrants({
        actor: {
          scope: "internal",
          type: "automation",
          id: "automation-1",
          role: "delegate",
        },
        execution: organizationExecution,
      }),
    ).resolves.toEqual(BACKOFFICE_AUTHORITY_ROLE_GRANTS.automation);

    await expect(
      resolver.resolveActorCapabilityGrants({
        actor: {
          scope: "external",
          source: "telegram",
          type: "chat",
          id: "chat-2",
          role: "delegate",
        },
        execution: organizationExecution,
      }),
    ).resolves.toEqual([]);
  });
});
