import { describe, expect, test } from "vitest";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { InMemoryAdapter } from "@fragno-dev/db";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import {
  buildExternalIdentityBindingId,
  ExternalIdentityBindingConflictError,
  type ExternalIdentity,
} from "./external-identities";
import { createAutomationFragment } from "./index";

const telegramChat = (id: string): ExternalIdentity => ({
  scope: "external",
  source: "telegram",
  type: "chat",
  id,
});

const createAutomation = (idSeed: string) => {
  const databaseAdapter = new InMemoryAdapter({ idSeed });
  const workflows = createWorkflowsFragment(
    {
      workflows: {},
      runtime: defaultFragnoRuntime,
    },
    {
      databaseAdapter,
      dbRoundtripGuard: true,
      mountRoute: "/api/automations-workflows",
    },
  );
  const automation = createAutomationFragment(
    { ownerScope: { kind: "org", orgId: "org-1" } },
    {
      databaseAdapter,
      dbRoundtripGuard: true,
      mountRoute: "/api/automations",
    },
    { workflows: workflows.services },
  );

  return automation;
};

const expectBindingConflict = async (
  operation: Promise<unknown>,
  reason: ExternalIdentityBindingConflictError["reason"],
) => {
  await expect(operation).rejects.toMatchObject({
    name: "ExternalIdentityBindingConflictError",
    reason,
  });
};

describe("external identity binding IDs", () => {
  test("encode each identity component before joining them", () => {
    expect(
      buildExternalIdentityBindingId({
        scope: "external",
        source: "source:a",
        type: "type",
        id: "id",
      }),
    ).not.toBe(
      buildExternalIdentityBindingId({
        scope: "external",
        source: "source",
        type: "a:type",
        id: "id",
      }),
    );
  });
});

describe("external identity binding services", () => {
  test("applies binding, revocation, and reactivation transitions", async () => {
    const fragment = createAutomation("external-identity-binding-lifecycle");
    const identity = telegramChat("chat-1");

    await expect(
      fragment.callServices(() => fragment.services.getExternalIdentityBinding({ identity })),
    ).resolves.toBeNull();
    await expect(
      fragment.callServices(() => fragment.services.resolveExternalIdentity({ identity })),
    ).resolves.toBeNull();

    await expect(
      fragment.callServices(() =>
        fragment.services.bindExternalIdentity({
          identity,
          userId: "user-1",
          verifiedByClaimId: "claim-1",
        }),
      ),
    ).resolves.toEqual({
      status: "active",
      outcome: "created",
      bindingId: buildExternalIdentityBindingId(identity),
      userId: "user-1",
      version: 0,
    });

    await expect(
      fragment.callServices(() =>
        fragment.services.bindExternalIdentity({
          identity,
          userId: "user-1",
          verifiedByClaimId: "claim-1",
        }),
      ),
    ).resolves.toMatchObject({ status: "active", outcome: "unchanged", userId: "user-1" });

    await expect(
      fragment.callServices(() =>
        fragment.services.bindExternalIdentity({
          identity,
          userId: "user-1",
          verifiedByClaimId: "claim-2",
        }),
      ),
    ).resolves.toMatchObject({ status: "active", outcome: "unchanged", userId: "user-1" });

    await expectBindingConflict(
      fragment.callServices(() =>
        fragment.services.bindExternalIdentity({
          identity,
          userId: "user-2",
          verifiedByClaimId: "claim-2",
        }),
      ),
      "verified-claim-used-for-another-user",
    );
    await expectBindingConflict(
      fragment.callServices(() =>
        fragment.services.revokeExternalIdentity({
          identity,
          expectedUserId: "user-2",
          expectedVersion: 0,
        }),
      ),
      "binding-owner-changed",
    );

    await expect(
      fragment.callServices(() =>
        fragment.services.revokeExternalIdentity({
          identity,
          expectedUserId: "user-1",
          expectedVersion: 0,
        }),
      ),
    ).resolves.toMatchObject({
      status: "revoked",
      outcome: "revoked",
      userId: "user-1",
      version: 1,
    });
    await expect(
      fragment.callServices(() => fragment.services.resolveExternalIdentity({ identity })),
    ).resolves.toBeNull();
    await expect(
      fragment.callServices(() => fragment.services.getExternalIdentityBinding({ identity })),
    ).resolves.toMatchObject({
      status: "revoked",
      identity,
      userId: "user-1",
      verifiedByClaimId: "claim-1",
      boundAt: expect.any(Date),
      revokedAt: expect.any(Date),
    });
    await expect(
      fragment.callServices(() =>
        fragment.services.revokeExternalIdentity({
          identity,
          expectedUserId: "user-1",
          expectedVersion: 0,
        }),
      ),
    ).resolves.toMatchObject({
      status: "revoked",
      outcome: "unchanged",
      userId: "user-1",
      version: 1,
    });

    await expect(
      fragment.callServices(() =>
        fragment.services.bindExternalIdentity({
          identity,
          userId: "user-1",
          verifiedByClaimId: "claim-2",
        }),
      ),
    ).resolves.toMatchObject({
      status: "revoked",
      outcome: "unchanged",
      userId: "user-1",
      version: 1,
    });

    await expect(
      fragment.callServices(() =>
        fragment.services.bindExternalIdentity({
          identity,
          userId: "user-1",
          verifiedByClaimId: "claim-1",
        }),
      ),
    ).resolves.toMatchObject({ status: "revoked", outcome: "unchanged", userId: "user-1" });

    await expect(
      fragment.callServices(() =>
        fragment.services.bindExternalIdentity({
          identity,
          userId: "user-2",
          verifiedByClaimId: "claim-3",
        }),
      ),
    ).resolves.toMatchObject({
      status: "active",
      outcome: "reactivated",
      userId: "user-2",
      version: 2,
    });

    await expect(
      fragment.callServices(() =>
        fragment.services.bindExternalIdentity({
          identity,
          userId: "user-1",
          verifiedByClaimId: "claim-1",
        }),
      ),
    ).resolves.toMatchObject({
      status: "superseded",
      outcome: "unchanged",
      userId: "user-1",
      version: 2,
    });
    await expectBindingConflict(
      fragment.callServices(() =>
        fragment.services.revokeExternalIdentity({
          identity,
          expectedUserId: "user-1",
          expectedVersion: 2,
        }),
      ),
      "binding-owner-changed",
    );

    await expect(
      fragment.callServices(() => fragment.services.resolveExternalIdentity({ identity })),
    ).resolves.toMatchObject({
      status: "active",
      identity,
      userId: "user-2",
      verifiedByClaimId: "claim-3",
      version: 2,
      boundAt: expect.any(Date),
    });
  });

  test("rejects a stale revocation after the same user reactivates the binding", async () => {
    const fragment = createAutomation("external-identity-binding-stale-revocation");
    const identity = telegramChat("chat-1");

    await fragment.callServices(() =>
      fragment.services.bindExternalIdentity({
        identity,
        userId: "user-1",
        verifiedByClaimId: "claim-1",
      }),
    );
    await fragment.callServices(() =>
      fragment.services.revokeExternalIdentity({
        identity,
        expectedUserId: "user-1",
        expectedVersion: 0,
      }),
    );
    await expect(
      fragment.callServices(() =>
        fragment.services.bindExternalIdentity({
          identity,
          userId: "user-1",
          verifiedByClaimId: "claim-2",
        }),
      ),
    ).resolves.toMatchObject({ status: "active", outcome: "reactivated", version: 2 });

    await expectBindingConflict(
      fragment.callServices(() =>
        fragment.services.revokeExternalIdentity({
          identity,
          expectedUserId: "user-1",
          expectedVersion: 0,
        }),
      ),
      "binding-version-changed",
    );
    await expect(
      fragment.callServices(() => fragment.services.resolveExternalIdentity({ identity })),
    ).resolves.toMatchObject({ status: "active", userId: "user-1", version: 2 });
  });

  test("rejects a verified claim already used by another current binding", async () => {
    const fragment = createAutomation("external-identity-binding-claim-conflict");
    const firstIdentity = telegramChat("chat-1");
    const secondIdentity = telegramChat("chat-2");

    await fragment.callServices(() =>
      fragment.services.bindExternalIdentity({
        identity: firstIdentity,
        userId: "user-1",
        verifiedByClaimId: "claim-1",
      }),
    );

    await expectBindingConflict(
      fragment.callServices(() =>
        fragment.services.bindExternalIdentity({
          identity: secondIdentity,
          userId: "user-1",
          verifiedByClaimId: "claim-1",
        }),
      ),
      "verified-claim-used-for-another-binding",
    );
    await expect(
      fragment.callServices(() =>
        fragment.services.getExternalIdentityBinding({ identity: secondIdentity }),
      ),
    ).resolves.toBeNull();
  });

  test("returns not found when revoking an identity without a binding", async () => {
    const fragment = createAutomation("external-identity-binding-missing-revoke");

    await expect(
      fragment.callServices(() =>
        fragment.services.revokeExternalIdentity({
          identity: telegramChat("missing"),
          expectedUserId: "user-1",
          expectedVersion: 0,
        }),
      ),
    ).resolves.toEqual({ status: "not-found" });
  });
});
