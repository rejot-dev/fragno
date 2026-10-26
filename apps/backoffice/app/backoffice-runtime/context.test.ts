import { describe, expect, test } from "vitest";

import {
  createBackofficeRequestExecution,
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "./context";

describe("Backoffice execution context", () => {
  test("represents an authenticated user as the current principal", () => {
    expect(
      createBackofficeUserExecution({
        scope: { kind: "org", orgId: "org-1", jurisdiction: null },
        userId: "user-1",
      }).actors,
    ).toEqual({
      initiator: {
        scope: "internal",
        type: "backoffice",
        id: "interactive",
        role: "initiator",
      },
      principal: {
        scope: "internal",
        type: "user",
        id: "user-1",
        role: "principal",
      },
      delegation: [],
    });
  });

  test("carries verified access-token authority separately from actor provenance", () => {
    const expiresAt = new Date("2026-07-28T17:00:00.000Z");

    expect(
      createBackofficeRequestExecution({
        scope: { kind: "org", orgId: "org-1", jurisdiction: null },
        verifiedRequestAuthority: {
          userId: "user-1",
          personalScope: { kind: "user" as const, userId: "user-1", jurisdiction: null },
          scopeRestriction: null,
          role: "admin",
          organization: { kind: "org" as const, orgId: "org-1", jurisdiction: null },
          administeredMember: null,
          expiresAt,
        },
      }),
    ).toMatchObject({
      userAuthority: {
        scopeRestriction: null,
        kind: "verified-request-authority",
        userId: "user-1",
        personalScope: { kind: "user", userId: "user-1", jurisdiction: null },
        role: "admin",
        organization: { kind: "org", orgId: "org-1", jurisdiction: null },
        expiresAtEpochMs: expiresAt.getTime(),
      },
    });
  });

  test("distinguishes principal-free system execution from service execution", () => {
    expect(createBackofficeSystemExecution({ kind: "system" }).actors.principal).toBeNull();
    expect(
      createBackofficeServiceExecution({
        scope: { kind: "org", orgId: "org-1", jurisdiction: null },
        service: { type: "automation", id: "automation-1" },
      }).actors.principal,
    ).toEqual({
      scope: "internal",
      type: "automation",
      id: "automation-1",
      role: "principal",
    });
  });
});
