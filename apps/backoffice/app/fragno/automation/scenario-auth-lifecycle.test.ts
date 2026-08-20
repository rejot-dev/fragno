import { describe, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

describe("Better Auth lifecycle scenarios", () => {
  test("manages sessions, organizations, invitations, and sign-out", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Better Auth session and organization lifecycle",
        vars: () => ({
          ownerCookie: "",
          memberCookie: "",
          ownerPersonalOrganizationId: "",
          sharedOrganizationId: "",
          invitationId: "",
        }),
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "owner@example.com",
            captureSessionCookieAs: "ownerCookie",
          }),
          when.auth.signUp({
            email: "member@example.com",
            captureSessionCookieAs: "memberCookie",
          }),
          then.auth.personalOrganization({
            cookie: ({ vars }) => vars.ownerCookie,
            captureOrganizationIdAs: "ownerPersonalOrganizationId",
          }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.ownerCookie,
            name: "Shared Workspace",
            slug: "shared-workspace",
            captureOrganizationIdAs: "sharedOrganizationId",
          }),
          when.auth.inviteMember({
            cookie: ({ vars }) => vars.ownerCookie,
            organizationId: ({ vars }) => vars.sharedOrganizationId,
            email: "member@example.com",
            captureInvitationIdAs: "invitationId",
          }),
          when.auth.acceptInvitation({
            cookie: ({ vars }) => vars.memberCookie,
            invitationId: ({ vars }) => vars.invitationId,
          }),
          then.auth.sessionHasOrganization({
            cookie: ({ vars }) => vars.memberCookie,
            organizationId: ({ vars }) => vars.sharedOrganizationId,
          }),
          when.auth.signOut({ cookie: ({ vars }) => vars.memberCookie }),
          then.auth.signedOut({ cookie: ({ vars }) => vars.memberCookie }),
        ],
      }),
    );
  });
});
