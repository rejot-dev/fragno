import { describe, expect, test, assert } from "vitest";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";

import {
  createBackofficeAuthorityResolver,
  type BackofficeIdentityDirectory,
  withBackofficeActorCapabilityGrants,
} from "./authority-resolver";
import { BACKOFFICE_AUTHORITY_ROLE_GRANTS } from "./authority-roles";
import { BACKOFFICE_PERMISSION } from "./permissions";

class MemoryIdentityDirectory implements BackofficeIdentityDirectory {
  lookupCount = 0;
  readonly #activeUsers = new Set<string>();
  readonly #memberships = new Set<string>();
  readonly #systemAdministrators = new Set<string>();

  activate(userId: string) {
    this.#activeUsers.add(userId);
  }

  ban(userId: string) {
    this.#activeUsers.delete(userId);
  }

  add(organizationId: string, userId: string) {
    this.#memberships.add(`${organizationId}:${userId}`);
  }

  remove(organizationId: string, userId: string) {
    this.#memberships.delete(`${organizationId}:${userId}`);
  }

  grantSystemAdministration(userId: string) {
    this.#systemAdministrators.add(userId);
  }

  revokeSystemAdministration(userId: string) {
    this.#systemAdministrators.delete(userId);
  }

  async getUserAuthorityFacts(input: { userId: string; organizationId?: string }) {
    this.lookupCount += 1;
    return {
      active: this.#activeUsers.has(input.userId),
      role: this.#systemAdministrators.has(input.userId) ? ("admin" as const) : ("user" as const),
      organizationMember: input.organizationId
        ? this.#memberships.has(`${input.organizationId}:${input.userId}`)
        : false,
    };
  }
}

const principal = {
  scope: "internal" as const,
  type: "user",
  id: "user-1",
  role: "principal" as const,
};

const organizationExecution: BackofficeExecutionContext = {
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
  test("trusts verified access-token authority without an identity lookup", async () => {
    const identities = new MemoryIdentityDirectory();
    const resolver = createBackofficeAuthorityResolver(identities, { now: () => 1_000 });
    const accessTokenAuthority = {
      kind: "verified-request-authority" as const,
      userId: principal.id,
      role: "admin" as const,
      organizationId: "org-1",
      expiresAtEpochMs: 2_000,
    };

    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: {
          ...organizationExecution,
          userAuthority: accessTokenAuthority,
        },
      }),
    ).resolves.toEqual(BACKOFFICE_AUTHORITY_ROLE_GRANTS["system-administrator"]);
    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: {
          ...organizationExecution,
          scope: { kind: "user", userId: principal.id },
          userAuthority: accessTokenAuthority,
        },
      }),
    ).resolves.toEqual(BACKOFFICE_AUTHORITY_ROLE_GRANTS["system-administrator"]);
    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: {
          ...organizationExecution,
          scope: { kind: "system" },
          userAuthority: accessTokenAuthority,
        },
      }),
    ).resolves.toEqual(BACKOFFICE_AUTHORITY_ROLE_GRANTS["system-administrator"]);

    assert(identities.lookupCount === 0);
  });

  test("denies expired access-token authority without falling back to current identity state", async () => {
    const identities = new MemoryIdentityDirectory();
    identities.activate(principal.id);
    identities.add("org-1", principal.id);
    const resolver = createBackofficeAuthorityResolver(identities, { now: () => 2_000 });

    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: {
          ...organizationExecution,
          userAuthority: {
            kind: "verified-request-authority",
            userId: principal.id,
            role: "user",
            organizationId: "org-1",
            expiresAtEpochMs: 2_000,
          },
        },
      }),
    ).resolves.toEqual([]);

    assert(identities.lookupCount === 0);
  });

  test("re-evaluates current organization membership without access-token authority", async () => {
    const identities = new MemoryIdentityDirectory();
    const resolver = createBackofficeAuthorityResolver(identities);

    identities.activate("user-1");
    identities.add("org-1", "user-1");
    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: organizationExecution,
      }),
    ).resolves.toEqual(BACKOFFICE_AUTHORITY_ROLE_GRANTS["organization-member"]);

    identities.remove("org-1", "user-1");
    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: organizationExecution,
      }),
    ).resolves.toEqual([]);
  });

  test("grants user-scope authority only to an active matching user", async () => {
    const identities = new MemoryIdentityDirectory();
    identities.activate("user-1");
    const resolver = createBackofficeAuthorityResolver(identities);

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

  test("re-evaluates current system administration", async () => {
    const identities = new MemoryIdentityDirectory();
    const resolver = createBackofficeAuthorityResolver(identities);
    const systemExecution: BackofficeExecutionContext = {
      scope: { kind: "system" },
      actors: {
        initiator: {
          scope: "internal",
          type: "backoffice",
          id: "interactive",
          role: "initiator",
        },
        principal,
        delegation: [],
      },
    };

    identities.activate(principal.id);
    identities.grantSystemAdministration(principal.id);
    await expect(
      resolver.resolvePrincipalPermissions({ principal, execution: systemExecution }),
    ).resolves.toEqual(BACKOFFICE_AUTHORITY_ROLE_GRANTS["system-administrator"]);

    identities.revokeSystemAdministration(principal.id);
    await expect(
      resolver.resolvePrincipalPermissions({ principal, execution: systemExecution }),
    ).resolves.toEqual([]);
  });

  test("denies missing and banned users even when stale authority facts remain", async () => {
    const identities = new MemoryIdentityDirectory();
    const resolver = createBackofficeAuthorityResolver(identities);

    identities.add("org-1", principal.id);
    identities.grantSystemAdministration(principal.id);

    await expect(
      resolver.resolvePrincipalPermissions({ principal, execution: organizationExecution }),
    ).resolves.toEqual([]);

    identities.activate(principal.id);
    identities.ban(principal.id);

    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: {
          scope: { kind: "user", userId: principal.id },
          actors: organizationExecution.actors,
        },
      }),
    ).resolves.toEqual([]);
    await expect(
      resolver.resolvePrincipalPermissions({
        principal,
        execution: {
          scope: { kind: "system" },
          actors: organizationExecution.actors,
        },
      }),
    ).resolves.toEqual([]);
    await expect(
      resolver.resolvePrincipalPermissions({ principal, execution: organizationExecution }),
    ).resolves.toEqual([]);
  });

  test("re-evaluates a ban after authority was granted", async () => {
    const identities = new MemoryIdentityDirectory();
    const resolver = createBackofficeAuthorityResolver(identities);
    identities.activate(principal.id);
    identities.add("org-1", principal.id);

    await expect(
      resolver.resolvePrincipalPermissions({ principal, execution: organizationExecution }),
    ).resolves.toEqual(BACKOFFICE_AUTHORITY_ROLE_GRANTS["organization-member"]);

    identities.ban(principal.id);
    await expect(
      resolver.resolvePrincipalPermissions({ principal, execution: organizationExecution }),
    ).resolves.toEqual([]);
  });

  test("grants explicit roles to trusted internal service principals", async () => {
    const resolver = createBackofficeAuthorityResolver(new MemoryIdentityDirectory());
    const automationPrincipal = {
      scope: "internal" as const,
      type: "automation",
      id: "automation-1",
      role: "principal" as const,
    };

    await expect(
      resolver.resolvePrincipalPermissions({
        principal: automationPrincipal,
        execution: {
          scope: organizationExecution.scope,
          actors: {
            initiator: {
              scope: "internal",
              type: "system",
              id: "backoffice",
              role: "initiator",
            },
            principal: automationPrincipal,
            delegation: [],
          },
        },
      }),
    ).resolves.toEqual(BACKOFFICE_AUTHORITY_ROLE_GRANTS.automation);
  });

  test("uses runtime-supplied grants for one trusted capability delegate", async () => {
    const baseResolver = createBackofficeAuthorityResolver(new MemoryIdentityDirectory());
    const actor = {
      scope: "internal" as const,
      type: "capability",
      id: "codemode-script",
      role: "delegate" as const,
    };
    const resolver = withBackofficeActorCapabilityGrants({
      resolver: baseResolver,
      actor,
      grants: [BACKOFFICE_PERMISSION.router.modify, BACKOFFICE_PERMISSION.router.read],
    });

    await expect(
      resolver.resolveActorCapabilityGrants({ actor, execution: organizationExecution }),
    ).resolves.toEqual([BACKOFFICE_PERMISSION.router.modify, BACKOFFICE_PERMISSION.router.read]);
  });

  test("grants capabilities only to trusted internal runtime actors", async () => {
    const resolver = createBackofficeAuthorityResolver(new MemoryIdentityDirectory());

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
