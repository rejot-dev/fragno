import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { Role } from "@/fragno/auth/contracts";

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

export type ScenarioAuthUserRoleInput = { userId: string; role: Role };
export type ScenarioAuthUserStatusInput = { userId: string; status: "active" | "banned" };
export type ScenarioAuthMemberRolesInput = ScenarioAuthMemberInput & { roles: readonly string[] };
export type ScenarioAuthMemberRemoveInput = Pick<ScenarioAuthMemberInput, "orgId" | "userId">;

export const normalizeScenarioAuthRoles = (roles: readonly string[]): string[] =>
  [
    ...new Set(
      roles.flatMap((role) => {
        const trimmedRole = role.trim();
        return trimmedRole ? [trimmedRole] : [];
      }),
    ),
  ].sort();

const auth = (runtime: InMemoryBackofficeRuntime) => runtime.objects.auth.singleton();

export const getScenarioAuthMemberRoles = async (
  runtime: InMemoryBackofficeRuntime,
  input: Pick<ScenarioAuthMemberInput, "orgId" | "userId">,
): Promise<string[] | null> =>
  await auth(runtime).getScenarioMemberRoles({
    organizationId: input.orgId,
    userId: input.userId,
  });

export const setUpScenarioAuthUser = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthUserInput,
) => {
  await auth(runtime).applyScenarioFixture({
    users: [
      {
        id: input.id,
        email: input.email?.trim().toLowerCase() || `${input.id}@scenario.test`,
        role: input.role ?? "user",
        status: input.status ?? "active",
      },
    ],
  });
};

export const setUpScenarioAuthOrganization = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthOrganizationInput,
) => {
  await auth(runtime).applyScenarioFixture({
    organizations: [
      {
        id: input.id,
        name: input.name ?? input.id,
        slug: input.slug ?? input.id.toLowerCase().replace(/[^a-z0-9]+/gu, "-"),
        ownerUserId: input.ownerUserId,
        ownerRoles: normalizeScenarioAuthRoles(input.ownerRoles ?? ["owner"]),
      },
    ],
  });
};

export const setUpScenarioAuthMember = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthMemberInput,
) => {
  await auth(runtime).applyScenarioFixture({
    members: [
      {
        organizationId: input.orgId,
        userId: input.userId,
        roles: normalizeScenarioAuthRoles(input.roles ?? ["member"]),
      },
    ],
  });
};

export const setScenarioAuthMemberRoles = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthMemberRolesInput,
) => {
  await setUpScenarioAuthMember(runtime, input);
};

export const setScenarioAuthUserRole = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthUserRoleInput,
) => {
  const facts = await auth(runtime).getUserAuthorityFacts({ userId: input.userId });
  if (!facts.role) {
    throw new Error(`Scenario auth user ${input.userId} does not exist.`);
  }
  await auth(runtime).applyScenarioFixture({
    users: [
      {
        id: input.userId,
        email: `${input.userId}@scenario.test`,
        role: input.role,
        status: facts.active ? "active" : "banned",
      },
    ],
  });
};

export const setScenarioAuthUserStatus = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthUserStatusInput,
) => {
  const facts = await auth(runtime).getUserAuthorityFacts({ userId: input.userId });
  if (!facts.role) {
    throw new Error(`Scenario auth user ${input.userId} does not exist.`);
  }
  await auth(runtime).applyScenarioFixture({
    users: [
      {
        id: input.userId,
        email: `${input.userId}@scenario.test`,
        role: facts.role,
        status: input.status,
      },
    ],
  });
};

export const removeScenarioAuthMember = async (
  runtime: InMemoryBackofficeRuntime,
  input: ScenarioAuthMemberRemoveInput,
) => {
  await auth(runtime).applyScenarioFixture({
    removedMembers: [{ organizationId: input.orgId, userId: input.userId }],
  });
};
