import { describe, expect, test, vi } from "vitest";

import { createAdminRuntime } from "./admin-runtime";

function createAdminRuntimeDependencies() {
  return {
    auth: {
      createAdminOrganization: async (input: { name: string; slug: string }) => ({
        organizationId: "org-1",
        name: input.name,
        slug: input.slug,
        ownerUserId: "owner-1",
      }),
      getOrganizationBySlug: async (slug: string) =>
        slug === "acme" ? { id: "org-1", slug } : null,
      addAdminOrganizationMember: async (input: {
        organizationId: string;
        roles: readonly string[];
      }) => ({
        organizationId: input.organizationId,
        userId: "user-1",
        roles: [...input.roles],
      }),
      removeAdminOrganizationMember: async (input: { organizationId: string }) => ({
        organizationId: input.organizationId,
        userId: "user-1",
        roles: ["member"],
      }),
    },
    otp: {
      issueSignUpInvitation: vi.fn(async (input) => ({
        invitationId: "invitation-1",
        email: input.email,
        url: `${input.publicBaseUrl}backoffice/sign-up?invitationId=invitation-1&code=ABC12345`,
        ttlDays: input.ttlDays ?? 7,
        type: "sign_up_invitation" as const,
      })),
    },
    publicBaseUrl: "https://backoffice.example/",
  } satisfies Parameters<typeof createAdminRuntime>[0];
}

describe("createAdminRuntime", () => {
  test("creates sign-up invitations through the singleton OTP object", async () => {
    const dependencies = createAdminRuntimeDependencies();
    const runtime = createAdminRuntime(dependencies);

    await expect(
      runtime.createSignUpInvitation({ email: "person@example.com", ttlDays: 3 }),
    ).resolves.toEqual({
      invitationId: "invitation-1",
      email: "person@example.com",
      url: "https://backoffice.example/backoffice/sign-up?invitationId=invitation-1&code=ABC12345",
      ttlDays: 3,
    });
    expect(dependencies.otp.issueSignUpInvitation).toHaveBeenCalledWith({
      email: "person@example.com",
      ttlDays: 3,
      publicBaseUrl: "https://backoffice.example/",
    });
  });

  test("reports unavailable sign-up invitation dependencies", async () => {
    const dependencies = createAdminRuntimeDependencies();
    const withoutOtp = createAdminRuntime({ ...dependencies, otp: null });
    const withoutPublicBaseUrl = createAdminRuntime({ ...dependencies, publicBaseUrl: null });

    await expect(
      withoutOtp.createSignUpInvitation({ email: "person@example.com" }),
    ).rejects.toThrow("requires the OTP binding");
    await expect(
      withoutPublicBaseUrl.createSignUpInvitation({ email: "person@example.com" }),
    ).rejects.toThrow("requires DOCS_PUBLIC_BASE_URL");
  });

  test("resolves organization slugs before changing membership", async () => {
    const dependencies = createAdminRuntimeDependencies();
    const membershipCalls: unknown[] = [];
    dependencies.auth.addAdminOrganizationMember = async (input) => {
      membershipCalls.push(["add", input]);
      return { organizationId: input.organizationId, userId: "user-1", roles: [...input.roles] };
    };
    dependencies.auth.removeAdminOrganizationMember = async (input) => {
      membershipCalls.push(["remove", input]);
      return { organizationId: input.organizationId, userId: "user-1", roles: ["member"] };
    };
    const runtime = createAdminRuntime(dependencies);

    await expect(
      runtime.addOrganizationMember({
        organizationSlug: "acme",
        userEmail: "member@example.com",
        roles: ["member"],
      }),
    ).resolves.toEqual({ organizationId: "org-1", userId: "user-1", roles: ["member"] });
    await expect(
      runtime.removeOrganizationMember({
        organizationSlug: "acme",
        userEmail: "member@example.com",
      }),
    ).resolves.toEqual({ organizationId: "org-1", userId: "user-1", roles: ["member"] });
    expect(membershipCalls).toEqual([
      [
        "add",
        {
          organizationId: "org-1",
          userEmail: "member@example.com",
          roles: ["member"],
        },
      ],
      ["remove", { organizationId: "org-1", userEmail: "member@example.com" }],
    ]);
  });

  test("reports the missing organization slug before changing membership", async () => {
    const dependencies = createAdminRuntimeDependencies();
    dependencies.auth.getOrganizationBySlug = async () => null;
    const runtime = createAdminRuntime(dependencies);

    await expect(
      runtime.addOrganizationMember({
        organizationSlug: "missing",
        userEmail: "member@example.com",
        roles: ["member"],
      }),
    ).rejects.toThrow(
      "Admin organization member command could not find organization slug 'missing'.",
    );
  });
});
