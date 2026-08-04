import type { Role } from "@fragno-dev/auth";

import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { AuthFragment } from "@/fragno/auth/auth";

import { InMemoryAuthObject } from "../../../workers/auth.do";

export type ScenarioAuthUserInput = {
  id: string;
  email?: string;
  role?: Role;
  status?: "active" | "banned";
};

export type ScenarioAuthOrganizationInput = {
  id: string;
  name?: string;
  slug?: string;
  ownerUserId: string;
  ownerRoles?: readonly string[];
};

export type ScenarioAuthMemberInput = {
  orgId: string;
  userId: string;
  roles?: readonly string[];
};

export type ScenarioAuthUserRoleInput = {
  userId: string;
  role: Role;
};

export type ScenarioAuthUserStatusInput = {
  userId: string;
  status: "active" | "banned";
};

export type ScenarioAuthMemberRolesInput = ScenarioAuthMemberInput & {
  roles: readonly string[];
};

export type ScenarioAuthMemberRemoveInput = Pick<ScenarioAuthMemberInput, "orgId" | "userId">;

type ScenarioAuthServices = AuthFragment["services"];

export const normalizeScenarioAuthRoles = (roles: readonly string[]): string[] =>
  [
    ...new Set(
      roles.flatMap((role) => {
        const normalizedRole = role.trim();
        return normalizedRole ? [normalizedRole] : [];
      }),
    ),
  ].sort();

// Use the fragment owned by the Auth object so scenarios share its services and persistence rules.
// Scenario state controls suppress lifecycle hooks so they do not introduce unstated events.
const getScenarioAuthFragment = (runtime: InMemoryBackofficeRuntime): AuthFragment => {
  const authObject = runtime.objects.auth.singleton();
  if (!(authObject instanceof InMemoryAuthObject)) {
    throw new Error("Scenario Auth fixtures require the in-memory Auth object.");
  }
  return authObject.getFragment();
};

const callScenarioAuthService = <TServiceCall>(
  runtime: InMemoryBackofficeRuntime,
  createCall: (services: ScenarioAuthServices) => TServiceCall,
) => {
  const fragment = getScenarioAuthFragment(runtime);
  return fragment.callServices(() => createCall(fragment.services));
};

const getScenarioAuthOrganizationManager = async (
  runtime: InMemoryBackofficeRuntime,
  organizationId: string,
) => {
  const organizationResult = await callScenarioAuthService(runtime, (services) =>
    services.getOrganizationById(organizationId),
  );
  if (!organizationResult) {
    throw new Error(`Scenario auth organization ${organizationId} does not exist.`);
  }

  const managerUserId = organizationResult.organization.createdBy;
  const authority = await callScenarioAuthService(runtime, (services) =>
    services.getUserAuthorityFacts({ userId: managerUserId, organizationId }),
  );
  if (!authority.role || !authority.organizationMember) {
    throw new Error(
      `Scenario auth organization ${organizationId} has no usable creator membership.`,
    );
  }

  return {
    organization: organizationResult.organization,
    actor: {
      userId: managerUserId,
      userRole: authority.role,
    },
  };
};

const getScenarioAuthMember = async (
  runtime: InMemoryBackofficeRuntime,
  input: Pick<ScenarioAuthMemberInput, "orgId" | "userId">,
) =>
  await callScenarioAuthService(runtime, (services) =>
    services.getOrganizationMemberByUser({
      organizationId: input.orgId,
      userId: input.userId,
    }),
  );

export const getScenarioAuthMemberRoles = async (
  runtime: InMemoryBackofficeRuntime,
  input: Pick<ScenarioAuthMemberInput, "orgId" | "userId">,
): Promise<string[] | null> => {
  const member = await getScenarioAuthMember(runtime, input);
  if (!member) {
    return null;
  }

  const result = await callScenarioAuthService(runtime, (services) =>
    services.listOrganizationMemberRoles(member.id),
  );
  return normalizeScenarioAuthRoles(result.roles);
};

export const setUpScenarioAuthUser = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthUserInput,
) => {
  const role = input.role ?? "user";
  const status = input.status ?? "active";
  const authority = await callScenarioAuthService(runtime, (services) =>
    services.getUserAuthorityFacts({ userId: input.id }),
  );

  if (authority.role === null) {
    const created = await callScenarioAuthService(runtime, (services) =>
      services.createUserUnvalidated(
        input.email?.trim().toLowerCase() || `${input.id}@scenario.test`,
        "scenario-password-hash",
        role,
        {
          id: input.id,
          bannedAt: status === "banned" ? new Date(runtime.now()) : null,
          emitHooks: false,
        },
      ),
    );
    if (created.id !== input.id) {
      throw new Error(`Scenario auth created user ${created.id} instead of ${input.id}.`);
    }
    return;
  }

  const expectedEmail = input.email;
  if (expectedEmail) {
    const userByEmail = await callScenarioAuthService(runtime, (services) =>
      services.getUserByEmail(expectedEmail),
    );
    if (userByEmail?.id !== input.id) {
      throw new Error(
        `Scenario auth user ${input.id} already exists with a different email address.`,
      );
    }
  }

  if (authority.role !== role) {
    await callScenarioAuthService(runtime, (services) =>
      services.setUserRole(input.id, role, { emitHooks: false }),
    );
  }
  if (authority.active !== (status === "active")) {
    const result = await callScenarioAuthService(runtime, (services) =>
      services.setUserBannedAt(input.id, status === "banned" ? new Date(runtime.now()) : null),
    );
    if (!result.ok) {
      throw new Error(`Scenario auth user ${input.id} disappeared while changing status.`);
    }
  }
};

const ensureScenarioAuthUser = async (runtime: InMemoryBackofficeRuntime, userId: string) => {
  const authority = await callScenarioAuthService(runtime, (services) =>
    services.getUserAuthorityFacts({ userId }),
  );
  if (authority.role === null) {
    await setUpScenarioAuthUser(runtime, { id: userId });
  }
};

export const setUpScenarioAuthOrganization = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthOrganizationInput,
) => {
  await ensureScenarioAuthUser(runtime, input.ownerUserId);
  const ownerAuthority = await callScenarioAuthService(runtime, (services) =>
    services.getUserAuthorityFacts({ userId: input.ownerUserId }),
  );
  if (!ownerAuthority.role) {
    throw new Error(`Scenario auth owner ${input.ownerUserId} does not exist.`);
  }

  const ownerRole = ownerAuthority.role;
  const name = input.name?.trim() || input.id;
  const slug = input.slug?.trim() || input.id;
  const existing = await callScenarioAuthService(runtime, (services) =>
    services.getOrganizationById(input.id),
  );

  if (!existing) {
    const result = await callScenarioAuthService(runtime, (services) =>
      services.createOrganization({
        id: input.id,
        name,
        slug,
        creatorUserId: input.ownerUserId,
        creatorUserRole: ownerRole,
        creatorRoles: input.ownerRoles ?? ["owner"],
        emitHooks: false,
      }),
    );
    if (!result.ok) {
      throw new Error(`Scenario auth could not create organization ${input.id}: ${result.code}.`);
    }
    return;
  }

  if (existing.organization.createdBy !== input.ownerUserId) {
    throw new Error(
      `Scenario auth organization ${input.id} already belongs to ${existing.organization.createdBy}.`,
    );
  }

  const update = await callScenarioAuthService(runtime, (services) =>
    services.updateOrganization(
      input.id,
      { name, slug },
      { userId: input.ownerUserId, userRole: ownerRole },
      { emitHooks: false },
    ),
  );
  if (!update.ok) {
    throw new Error(`Scenario auth could not update organization ${input.id}: ${update.code}.`);
  }

  await setScenarioAuthMemberRoles(runtime, {
    orgId: input.id,
    userId: input.ownerUserId,
    roles: input.ownerRoles ?? ["owner"],
  });
};

export const setUpScenarioAuthMember = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthMemberInput,
) => {
  await ensureScenarioAuthUser(runtime, input.userId);
  const existing = await getScenarioAuthMember(runtime, input);
  const roles = input.roles ?? ["member"];

  if (!existing) {
    const { actor } = await getScenarioAuthOrganizationManager(runtime, input.orgId);
    const result = await callScenarioAuthService(runtime, (services) =>
      services.createOrganizationMember({
        organizationId: input.orgId,
        userId: input.userId,
        roles,
        actor,
        emitHooks: false,
      }),
    );
    if (!result.ok) {
      throw new Error(
        `Scenario auth could not add ${input.userId} to ${input.orgId}: ${result.code}.`,
      );
    }
    return;
  }

  await setScenarioAuthMemberRoles(runtime, { ...input, roles });
};

export const setScenarioAuthMemberRoles = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthMemberRolesInput,
) => {
  const member = await getScenarioAuthMember(runtime, input);
  if (!member) {
    throw new Error(`Scenario auth member ${input.userId} does not exist in ${input.orgId}.`);
  }

  const currentRoles = await getScenarioAuthMemberRoles(runtime, input);
  const nextRoles = normalizeScenarioAuthRoles(input.roles);
  if (JSON.stringify(currentRoles) === JSON.stringify(nextRoles)) {
    return;
  }

  const { actor } = await getScenarioAuthOrganizationManager(runtime, input.orgId);
  const result = await callScenarioAuthService(runtime, (services) =>
    services.updateOrganizationMemberRoles({
      organizationId: input.orgId,
      memberId: member.id,
      roles: input.roles,
      actor,
      emitHooks: false,
    }),
  );
  if (!result.ok) {
    throw new Error(
      `Scenario auth could not set roles for ${input.userId} in ${input.orgId}: ${result.code}.`,
    );
  }
};

export const setScenarioAuthUserRole = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthUserRoleInput,
) => {
  const authority = await callScenarioAuthService(runtime, (services) =>
    services.getUserAuthorityFacts({ userId: input.userId }),
  );
  if (!authority.role) {
    throw new Error(`Scenario auth user ${input.userId} does not exist.`);
  }
  if (authority.role !== input.role) {
    await callScenarioAuthService(runtime, (services) =>
      services.setUserRole(input.userId, input.role, { emitHooks: false }),
    );
  }
};

export const setScenarioAuthUserStatus = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthUserStatusInput,
) => {
  const result = await callScenarioAuthService(runtime, (services) =>
    services.setUserBannedAt(
      input.userId,
      input.status === "banned" ? new Date(runtime.now()) : null,
    ),
  );
  if (!result.ok) {
    throw new Error(`Scenario auth user ${input.userId} does not exist.`);
  }
};

export const removeScenarioAuthMember = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthMemberRemoveInput,
) => {
  const member = await getScenarioAuthMember(runtime, input);
  if (!member) {
    return;
  }

  const { actor } = await getScenarioAuthOrganizationManager(runtime, input.orgId);
  const result = await callScenarioAuthService(runtime, (services) =>
    services.removeOrganizationMember({
      organizationId: input.orgId,
      memberId: member.id,
      actor,
      emitHooks: false,
    }),
  );
  if (!result.ok) {
    throw new Error(
      `Scenario auth could not remove ${input.userId} from ${input.orgId}: ${result.code}.`,
    );
  }
};
