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
        scope: { kind: "org", orgId: "org-1" },
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
        scope: { kind: "org", orgId: "org-1" },
        userId: "user-1",
        verifiedRequestAuthority: {
          scopeRestriction: null,
          role: "admin",
          organizationId: "org-1",
          expiresAt,
        },
      }),
    ).toMatchObject({
      userAuthority: {
        scopeRestriction: null,
        kind: "verified-request-authority",
        userId: "user-1",
        role: "admin",
        organizationId: "org-1",
        expiresAtEpochMs: expiresAt.getTime(),
      },
    });
  });

  test("distinguishes principal-free system execution from service execution", () => {
    expect(createBackofficeSystemExecution({ kind: "system" }).actors.principal).toBeNull();
    expect(
      createBackofficeServiceExecution({
        scope: { kind: "org", orgId: "org-1" },
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
