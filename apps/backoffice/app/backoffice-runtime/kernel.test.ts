import { describe, expect, test } from "vitest";

import { BackofficeForbiddenError, BackofficeKernel } from "./kernel";

const kernel = new BackofficeKernel({});

describe("BackofficeKernel.assertScopeAllowedByOwner", () => {
  test("allows organization and project scopes owned by the organization", async () => {
    await expect(
      kernel.assertScopeAllowedByOwner({
        ownerScope: { kind: "org", orgId: "org-1" },
        targetScope: { kind: "org", orgId: "org-1" },
        operation: "billing.record-event",
      }),
    ).resolves.toBeUndefined();
    await expect(
      kernel.assertScopeAllowedByOwner({
        ownerScope: { kind: "org", orgId: "org-1" },
        targetScope: { kind: "project", orgId: "org-1", projectId: "project-1" },
        operation: "billing.record-event",
      }),
    ).resolves.toBeUndefined();
  });

  test("allows user scopes pending organization membership enforcement", async () => {
    await expect(
      kernel.assertScopeAllowedByOwner({
        ownerScope: { kind: "org", orgId: "org-1" },
        targetScope: { kind: "user", userId: "user-1" },
        operation: "billing.record-event",
      }),
    ).resolves.toBeUndefined();
  });

  test.each([
    { kind: "system" as const },
    { kind: "org" as const, orgId: "org-2" },
    { kind: "project" as const, orgId: "org-2", projectId: "project-1" },
  ])("rejects $kind scopes outside the owning organization", async (targetScope) => {
    await expect(
      kernel.assertScopeAllowedByOwner({
        ownerScope: { kind: "org", orgId: "org-1" },
        targetScope,
        operation: "billing.record-event",
      }),
    ).rejects.toThrow(BackofficeForbiddenError);
  });
});
