import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  return {
    DurableObject: MockDurableObject,
    RpcTarget: class MockRpcTarget {},
    WorkerEntrypoint: class MockWorkerEntrypoint {},
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { BackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import { BACKOFFICE_PI_WORKFLOW_NAME } from "@/fragno/pi/pi-shared";

const unexpectedRouteAuthorityResolver: BackofficeAuthorityResolver = {
  async resolvePrincipalPermissions() {
    throw new Error("Pi routes must rely on their trusted request boundary.");
  },
  async resolveActorCapabilityGrants() {
    throw new Error("Pi routes must rely on their trusted request boundary.");
  },
};

describe("Pi session authorization", () => {
  let runtime: InMemoryBackofficeRuntime;
  const scope = { kind: "org" as const, orgId: "org-1" };

  beforeEach(async () => {
    runtime = await createInMemoryBackofficeRuntime({
      authorityResolver: unexpectedRouteAuthorityResolver,
    });
    await runtime.objects.pi.forOrg(scope.orgId).setAdminConfig({
      scope,
      apiKeys: { openai: "test-openai-key" },
    });
  });

  afterEach(async () => {
    await runtime.cleanup();
  });

  const contextFor = (userId: string) => ({
    execution: createBackofficeUserExecution({ scope, userId }),
    propagationContext: null,
  });

  const jwtContextFor = ({
    userId,
    role,
    organizationIds,
  }: {
    userId: string;
    role: "user" | "admin";
    organizationIds: string[];
  }) => ({
    execution: createBackofficeUserExecution({
      scope,
      userId,
      verifiedAccessToken: {
        role,
        organizationIds,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    }),
    propagationContext: null,
  });

  const sessionUrl = (sessionId?: string) =>
    `http://pi.test/api/pi/workflows/${BACKOFFICE_PI_WORKFLOW_NAME}/sessions${sessionId ? `/${sessionId}` : ""}?scope=org%3Aorg-1`;

  const createSession = async (userId = "user-1") => {
    const response = await runtime.objects.pi.forOrg(scope.orgId).fetchWithContext(
      new Request(sessionUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metadata: { agentName: "default::openai::gpt-5.6-luna" },
          input: {},
        }),
      }),
      jwtContextFor({ userId, role: "user", organizationIds: [scope.orgId] }),
    );

    assert.equal(response.status, 200);
    return (await response.json()) as { id: string };
  };

  test("persists the trusted creator actors in workflow metadata", async () => {
    const creatorContext = contextFor("session-creator");
    const session = await createSession("session-creator");

    const response = await runtime.objects.pi
      .forOrg(scope.orgId)
      .fetch(
        new Request(
          `http://pi.test/api/pi-workflows/${BACKOFFICE_PI_WORKFLOW_NAME}/instances/${session.id}?scope=org%3Aorg-1`,
        ),
      );

    assert.equal(response.status, 200);
    const instance = (await response.json()) as {
      meta: { params: { metadata?: Record<string, unknown> } };
    };
    expect(instance.meta.params.metadata?.__backofficeActors).toEqual(
      creatorContext.execution.actors,
    );
  });

  test("allows a verified request role with the required permission", async () => {
    const session = await createSession();

    const response = await runtime.objects.pi
      .forOrg(scope.orgId)
      .fetchWithContext(
        new Request(sessionUrl(session.id)),
        jwtContextFor({ userId: "reader", role: "user", organizationIds: [scope.orgId] }),
      );

    assert.equal(response.status, 200);
  });

  test("checks verified JWT role and scope claims without resolving current user authority", async () => {
    const session = await createSession();

    const allowed = await runtime.objects.pi
      .forOrg(scope.orgId)
      .fetchWithContext(
        new Request(sessionUrl(session.id)),
        jwtContextFor({ userId: "member", role: "user", organizationIds: [scope.orgId] }),
      );
    assert.equal(allowed.status, 200);

    const denied = await runtime.objects.pi
      .forOrg(scope.orgId)
      .fetchWithContext(
        new Request(sessionUrl(session.id)),
        jwtContextFor({ userId: "non-member", role: "user", organizationIds: [] }),
      );
    assert.equal(denied.status, 403);
    await expect(denied.json()).resolves.toMatchObject({
      code: "principal-permission-denied",
    });
  });

  test("does not resolve current user authority for trusted session commands", async () => {
    const session = await createSession();

    const response = await runtime.objects.pi.forOrg(scope.orgId).fetchWithContext(
      new Request(
        `http://pi.test/api/pi/workflows/${BACKOFFICE_PI_WORKFLOW_NAME}/sessions/${session.id}/command?scope=org%3Aorg-1`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "prompt", input: { text: "trusted turn" } }),
        },
      ),
      jwtContextFor({
        userId: "another-user",
        role: "user",
        organizationIds: [scope.orgId],
      }),
    );

    assert.equal(response.status, 202);
    await expect(response.json()).resolves.toMatchObject({ accepted: true });
  });

  test("lists all sessions in scope for trusted context", async () => {
    const first = await createSession("user-1");
    const second = await createSession("user-2");

    const response = await runtime.objects.pi
      .forOrg(scope.orgId)
      .fetchWithContext(
        new Request(sessionUrl()),
        jwtContextFor({ userId: "reader", role: "user", organizationIds: [scope.orgId] }),
      );

    assert.equal(response.status, 200);
    const sessions = (await response.json()) as { id: string }[];
    expect(sessions.map((session) => session.id)).toEqual([second.id, first.id]);
  });

  test("rejects protected session routes without trusted execution context", async () => {
    const response = await runtime.objects.pi.forOrg(scope.orgId).fetch(new Request(sessionUrl()));

    assert.equal(response.status, 403);
    await expect(response.json()).resolves.toMatchObject({ code: "context-access-denied" });
  });
});
