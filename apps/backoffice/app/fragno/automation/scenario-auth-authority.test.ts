import { describe, test, vi } from "vitest";

import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

describe("scenario auth authority fixtures", () => {
  test("seeds and changes the authoritative user and organization membership state", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario auth authority changes",
        setup: ({ given }) => [
          given.auth.user({
            id: "owner-1",
            email: "owner@example.com",
          }),
          given.auth.user({
            id: "member-1",
            email: "member@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "owner-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "member-1",
            roles: ["operator", "reviewer"],
          }),
        ],
        steps: ({ when, then }) => [
          then.auth.authority({
            userId: "member-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "member-1",
            roles: ["operator", "reviewer"],
          }),
          then.auth.permissions({
            userId: "member-1",
            scope: { kind: "org", orgId: "org-1" },
            include: [
              BACKOFFICE_PERMISSION.otp.create,
              BACKOFFICE_PERMISSION.store.modify,
              BACKOFFICE_PERMISSION.telegram.send,
            ],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),

          when.auth.setUserRole({ userId: "member-1", role: "admin" }),
          then.auth.permissions({
            userId: "member-1",
            scope: { kind: "system" },
            include: [
              BACKOFFICE_PERMISSION.identity.bind,
              BACKOFFICE_PERMISSION.identity.resolve,
              BACKOFFICE_PERMISSION.identity.revoke,
            ],
          }),

          when.auth.setUserStatus({ userId: "member-1", status: "banned" }),
          then.auth.authority({
            userId: "member-1",
            orgId: "org-1",
            expected: {
              active: false,
              role: "admin",
              organizationMember: true,
            },
          }),
          then.auth.permissions({
            userId: "member-1",
            scope: { kind: "system" },
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),

          when.auth.setUserStatus({ userId: "member-1", status: "active" }),
          when.auth.setMemberRoles({
            orgId: "org-1",
            userId: "member-1",
            roles: ["member"],
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "member-1",
            roles: ["member"],
          }),
          when.auth.removeMember({ orgId: "org-1", userId: "member-1" }),
          then.auth.authority({
            userId: "member-1",
            orgId: "org-1",
            expected: {
              active: true,
              role: "admin",
              organizationMember: false,
            },
          }),
          then.auth.permissions({
            userId: "member-1",
            scope: { kind: "org", orgId: "org-1" },
            exclude: [BACKOFFICE_PERMISSION.store.modify],
          }),
        ],
      }),
    );
  });
});
