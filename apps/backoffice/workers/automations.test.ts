import { assert, describe, expect, test, vi } from "vitest";

import { unavailableBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import {
  BACKOFFICE_SYSTEM_ACTORS,
  createBackofficeServiceExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { TELEGRAM_TEST_COMMAND_WORKFLOW_V1_1_SOURCE } from "@/files/content/telegram-test-command";
import { loadAutomationCatalog } from "@/fragno/automation/catalog";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import { createAutomationRuntimeExecution } from "@/fragno/automation/engine/runtime-execution";
import {
  buildMarketplaceIngestionWorkflowInstanceId,
  MARKETPLACE_INGEST_WORKFLOW_NAME,
} from "@/fragno/automation/marketplace-ingest-workflow";
import {
  buildMarketplacePublicationWorkflowInstanceId,
  MARKETPLACE_PUBLISH_WORKFLOW_NAME,
} from "@/fragno/automation/marketplace-publish-workflow";
import {
  createAutomationsRouteCaller,
  createWorkflowsRouteCaller,
} from "@/fragno/automation/route-callers";
import { marketplaceListingId } from "@/fragno/marketplace/owner";

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

import { createDefaultAutomationFileSystem } from "./automations.do";

const objects = {} as BackofficeObjectRegistry;
const config: BackofficeRuntimeConfig = {
  authEmailVerification: { enabled: false },
  bindings: {
    api: false,
    auth: false,
    automations: false,
    billing: false,
    marketplace: false,
    telegram: false,
    otp: false,
    pi: false,
    resend: false,
    reson8: false,
    mcp: false,
    upload: false,
    github: false,
    githubWebhookRouter: false,
    cloudflare: false,
    sandbox: false,
  },
};

const createFileSystem = (execution: BackofficeExecutionContext) =>
  createDefaultAutomationFileSystem({
    objects,
    kernel: new BackofficeKernel({
      authorityResolver: unavailableBackofficeAuthorityResolver,
      kernelObserver: noopBackofficeKernelObserver,
    }),
    execution,
    config,
  });

const scopedEvent = (orgId: string): AutomationEvent => ({
  id: `github:issue.opened:${orgId}`,
  scope: { kind: "org", orgId },
  source: "github",
  eventType: "issue.opened",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: { issueId: "issue-1" },
  actors: {
    initiator: {
      scope: "external",
      source: "github",
      type: "user",
      id: "octocat",
      role: "initiator",
    },
    principal: null,
    delegation: [],
  },
  subject: { orgId },
});

describe("createDefaultAutomationFileSystem", () => {
  test("loads static and system automation files for system automation scope", async () => {
    const fs = await createFileSystem({
      actors: BACKOFFICE_SYSTEM_ACTORS,
      scope: { kind: "system" },
    });

    const catalog = await loadAutomationCatalog(fs);

    expect(catalog.scripts.map((script) => script.absolutePath)).toEqual(
      expect.arrayContaining([
        "/static/automations/project-files-configure.workflow.js",
        "/system/automations/workspace-file-initialization.workflow.js",
      ]),
    );
  });

  test("loads static automations for user automation scope", async () => {
    const fs = await createFileSystem(
      createBackofficeServiceExecution({
        scope: { kind: "user", userId: "user-1" },
        service: { type: "automation", id: "automation:event-1" },
      }),
    );

    const catalog = await loadAutomationCatalog(fs);

    expect(catalog.scripts.map((script) => script.absolutePath)).toEqual(
      expect.arrayContaining(["/static/automations/project-files-configure.workflow.js"]),
    );
    expect(catalog.scripts.map((script) => script.absolutePath)).not.toContain(
      "/system/automations/workspace-file-initialization.workflow.js",
    );
  });
});

describe("Automations fetchWithContext authorization", () => {
  test("allows a user-scoped automation to mutate its store", async () => {
    const runtime = await createInMemoryBackofficeRuntime();

    try {
      const scope = { kind: "user" as const, userId: "user-1" };
      const execution = createAutomationRuntimeExecution({
        id: "event-1",
        scope,
        source: "backoffice",
        eventType: "user.action",
        occurredAt: "2026-07-28T00:00:00.000Z",
        payload: {},
        actors: {
          initiator: {
            scope: "internal",
            type: "user",
            id: scope.userId,
            role: "initiator",
          },
          principal: null,
          delegation: [],
        },
        subject: { userId: scope.userId },
      });
      const automations = runtime.objects.automations.forUser({ userId: scope.userId });
      const callRoute = createAutomationsRouteCaller({
        object: automations,
        context: { execution },
      });

      await expect(
        callRoute("POST", "/store/set", {
          body: { key: "user/key", value: "value", category: ["ordinary"] },
        }),
      ).resolves.toMatchObject({
        type: "json",
        data: { key: "user/key", value: "value" },
      });
      await expect(
        callRoute("GET", "/store/get", { query: { key: "user/key" } }),
      ).resolves.toMatchObject({
        type: "json",
        data: { key: "user/key", value: "value" },
      });
    } finally {
      await runtime.cleanup();
    }
  });

  test("allows a current administrator to mutate the system store", async () => {
    const runtime = await createInMemoryBackofficeRuntime({
      objectFactories: {
        AUTH: () =>
          ({
            async getUserAuthorityFacts({ userId }: { userId: string }) {
              return {
                active: true,
                role: userId === "admin-1" ? "admin" : "user",
                organizationMember: false,
              };
            },
          }) as never,
      },
    });

    try {
      const scope = { kind: "system" as const };
      const execution = createBackofficeUserExecution({ scope, userId: "admin-1" });
      const automations = runtime.objects.automations.singleton();
      const callActionRoute = createAutomationsRouteCaller({
        object: automations,
        context: { execution },
      });

      await expect(
        callActionRoute("POST", "/store/set", {
          body: { key: "system/key", value: "value" },
        }),
      ).resolves.toMatchObject({
        type: "json",
        data: { key: "system/key", value: "value" },
      });
      await expect(
        callActionRoute("POST", "/store/delete", { body: { key: "system/key" } }),
      ).resolves.toMatchObject({
        type: "json",
        data: { ok: true, key: "system/key" },
      });

      const nonAdministratorExecution = createBackofficeUserExecution({
        scope,
        userId: "user-1",
      });
      const deniedCallRoute = createAutomationsRouteCaller({
        object: automations,
        context: { execution: nonAdministratorExecution },
      });
      await expect(
        deniedCallRoute("POST", "/store/set", {
          body: { key: "system/denied", value: "value" },
        }),
      ).resolves.toMatchObject({
        type: "error",
        status: 403,
        error: { code: "principal-permission-denied" },
      });

      const deniedEntry = await createAutomationsRouteCaller({ object: automations })(
        "GET",
        "/store/get",
        { query: { key: "system/denied" } },
      );
      expect(deniedEntry).toMatchObject({ type: "error", status: 404 });
    } finally {
      await runtime.cleanup();
    }
  });

  test("uses verified access-token authority without calling Auth", async () => {
    const getUserAuthorityFacts = vi.fn(async () => {
      throw new Error("Auth should not be called for verified access-token authority.");
    });
    const runtime = await createInMemoryBackofficeRuntime({
      objectFactories: {
        AUTH: () => ({ getUserAuthorityFacts }) as never,
      },
    });

    try {
      const scope = { kind: "org" as const, orgId: "org-1" };
      const execution = createBackofficeUserExecution({
        scope,
        userId: "user-1",
        verifiedAccessToken: {
          role: "user",
          organizationIds: [scope.orgId],
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        },
      });
      const callRoute = createAutomationsRouteCaller({
        object: runtime.objects.automations.forOrg(scope.orgId),
        context: { execution },
      });

      await expect(
        callRoute("POST", "/store/set", {
          body: { key: "org/key", value: "value" },
        }),
      ).resolves.toMatchObject({
        type: "json",
        data: { key: "org/key", value: "value" },
      });
      expect(getUserAuthorityFacts).not.toHaveBeenCalled();
    } finally {
      await runtime.cleanup();
    }
  });

  test("denies banned users without access-token authority despite stale role and membership records", async () => {
    const runtime = await createInMemoryBackofficeRuntime({
      objectFactories: {
        AUTH: () =>
          ({
            async getUserAuthorityFacts() {
              return {
                active: false,
                role: "admin",
                organizationMember: true,
              } as const;
            },
          }) as never,
      },
    });

    try {
      const scope = { kind: "user" as const, userId: "user-1" };
      const execution = createBackofficeUserExecution({ scope, userId: scope.userId });
      const callRoute = createAutomationsRouteCaller({
        object: runtime.objects.automations.forUser({ userId: scope.userId }),
        context: { execution },
      });

      await expect(
        callRoute("POST", "/store/set", {
          body: { key: "user/key", value: "value" },
        }),
      ).resolves.toMatchObject({
        type: "error",
        status: 403,
        error: { code: "principal-permission-denied" },
      });
    } finally {
      await runtime.cleanup();
    }
  });

  test("reports authority resolution outages as HTTP 503", async () => {
    const runtime = await createInMemoryBackofficeRuntime({
      authorityResolver: unavailableBackofficeAuthorityResolver,
    });

    try {
      const scope = { kind: "user" as const, userId: "user-1" };
      const execution = createBackofficeUserExecution({ scope, userId: scope.userId });
      const callRoute = createAutomationsRouteCaller({
        object: runtime.objects.automations.forUser({ userId: scope.userId }),
        context: { execution },
      });

      await expect(
        callRoute("POST", "/store/set", {
          body: { key: "user/key", value: "value" },
        }),
      ).resolves.toMatchObject({
        type: "error",
        status: 503,
        error: {
          message: "Backoffice authority resolution is unavailable.",
          code: "authority-unavailable",
        },
      });
    } finally {
      await runtime.cleanup();
    }
  });

  test("preserves delegated actor capability denial reasons", async () => {
    const runtime = await createInMemoryBackofficeRuntime({
      authorityResolver: {
        async resolvePrincipalPermissions() {
          return [BACKOFFICE_PERMISSION.store.modify];
        },
        async resolveActorCapabilityGrants() {
          return [];
        },
      },
    });

    try {
      const scope = { kind: "user" as const, userId: "user-1" };
      const userExecution = createBackofficeUserExecution({ scope, userId: scope.userId });
      const execution: BackofficeExecutionContext = {
        ...userExecution,
        actors: {
          ...userExecution.actors,
          delegation: [
            {
              scope: "internal",
              type: "automation",
              id: "automation-1",
              role: "delegate",
            },
          ],
        },
      };
      const callRoute = createAutomationsRouteCaller({
        object: runtime.objects.automations.forUser({ userId: scope.userId }),
        context: { execution },
      });

      await expect(
        callRoute("POST", "/store/set", {
          body: { key: "user/key", value: "value" },
        }),
      ).resolves.toMatchObject({
        type: "error",
        status: 403,
        error: { code: "actor-capability-denied" },
      });
    } finally {
      await runtime.cleanup();
    }
  });

  test("rejects store mutation routes without trusted action context", async () => {
    const runtime = await createInMemoryBackofficeRuntime();

    try {
      const scope = { kind: "user" as const, userId: "user-1" };
      const automations = runtime.objects.automations.forUser({ userId: scope.userId });
      const callRoute = createAutomationsRouteCaller({ object: automations });

      await expect(
        callRoute("POST", "/store/set", {
          body: { key: "user/key", value: "value" },
        }),
      ).resolves.toMatchObject({
        type: "error",
        status: 403,
        error: { code: "AUTOMATIONS_ACTION_CONTEXT_REQUIRED" },
      });

      const directResponse = await automations.fetch(
        new Request("https://automations.do/api/automations/store/delete", {
          method: "POST",
          body: JSON.stringify({ key: "user/key" }),
        }),
      );
      assert(directResponse.status === 403);
      await expect(directResponse.json()).resolves.toMatchObject({
        code: "AUTOMATIONS_ACTION_CONTEXT_REQUIRED",
      });

      const malformedDirectResponse = await automations.fetch(
        new Request("https://automations.do/api/automations/store/set", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ actors: { principal: "user-1" } }),
        }),
      );
      assert(malformedDirectResponse.status === 403);
      await expect(malformedDirectResponse.json()).resolves.toMatchObject({
        code: "AUTOMATIONS_ACTION_CONTEXT_REQUIRED",
      });
    } finally {
      await runtime.cleanup();
    }
  });

  test("rejects malformed store input before authority resolution", async () => {
    const resolvePrincipalPermissions = vi.fn(async () => [
      { namespace: "store" as const, permission: "modify" as const },
    ]);
    const runtime = await createInMemoryBackofficeRuntime({
      authorityResolver: {
        resolvePrincipalPermissions,
        async resolveActorCapabilityGrants() {
          return [];
        },
      },
    });

    try {
      const scope = { kind: "user" as const, userId: "user-1" };
      const execution = createBackofficeServiceExecution({
        scope,
        service: { type: "automation", id: "automation:event-1" },
      });
      const automations = runtime.objects.automations.forUser({ userId: scope.userId });

      const malformedResponse = await automations.fetchWithContext(
        new Request("https://automations.do/api/automations/store/set", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key: "user/key",
            value: "value",
            actors: { principal: "user-1" },
          }),
        }),
        { execution },
      );
      assert(malformedResponse.status === 400);
      await expect(malformedResponse.json()).resolves.toMatchObject({
        code: "FRAGNO_VALIDATION_ERROR",
      });
      expect(resolvePrincipalPermissions).not.toHaveBeenCalled();

      const response = await createAutomationsRouteCaller({ object: automations })(
        "GET",
        "/store/get",
        { query: { key: "user/key" } },
      );
      expect(response).toMatchObject({ type: "error", status: 404 });
    } finally {
      await runtime.cleanup();
    }
  });

  test("does not mutate when the execution scope differs from the object scope", async () => {
    const runtime = await createInMemoryBackofficeRuntime();

    try {
      const automations = runtime.objects.automations.forUser({ userId: "user-1" });
      const execution = createBackofficeServiceExecution({
        scope: { kind: "user", userId: "user-2" },
        service: { type: "automation", id: "automation:event-1" },
      });

      const callRoute = createAutomationsRouteCaller({
        object: automations,
        context: { execution },
      });
      await expect(
        callRoute("POST", "/store/set", {
          body: { key: "user/key", value: "value" },
        }),
      ).rejects.toThrow("Backoffice object method scope does not match object address scope.");

      const response = await createAutomationsRouteCaller({ object: automations })(
        "GET",
        "/store/get",
        { query: { key: "user/key" } },
      );
      expect(response).toMatchObject({ type: "error", status: 404 });
    } finally {
      await runtime.cleanup();
    }
  });
});

describe("Automations object scope binding", () => {
  test("rejects events whose scope does not match the object address", async () => {
    const runtime = await createInMemoryBackofficeRuntime();

    try {
      await expect(
        runtime.objects.automations.singleton().ingestEvent(scopedEvent("org-1")),
      ).rejects.toThrow("Backoffice object method scope does not match object address scope.");
    } finally {
      await runtime.cleanup();
    }
  });

  test("rejects events whose scope does not match an already configured object", async () => {
    const runtime = await createInMemoryBackofficeRuntime();

    try {
      const automations = runtime.objects.automations.forOrg("org-1");
      await automations.ingestEvent(scopedEvent("org-1"));

      await expect(automations.ingestEvent(scopedEvent("org-2"))).rejects.toThrow(
        "Backoffice object method scope does not match object address scope.",
      );
    } finally {
      await runtime.cleanup();
    }
  });

  test("ingests marketplace artifacts into an organization member's user workspace", async () => {
    const runtime = await createInMemoryBackofficeRuntime({
      objectFactories: {
        AUTH: () =>
          ({
            hasOrganizationMember: async ({
              organizationId,
              userId,
            }: {
              organizationId: string;
              userId: string;
            }) => organizationId === "org-1" && userId === "user-1",
          }) as never,
      },
    });

    try {
      const automations = runtime.objects.automations.forOrg("org-1");
      await automations.requestStaticMarketplacePublications();
      await runtime.drain();

      const listingId = marketplaceListingId({
        ownerScope: { kind: "system" },
        slug: "telegram-test-command",
      });
      await expect(
        automations.requestMarketplaceIngestion({
          listingId,
          targetScope: { kind: "user", userId: "user-1" },
        }),
      ).resolves.toMatchObject({ state: "requested", version: "1.1.0" });
      await runtime.drain();

      await expect(
        automations.getMarketplaceIngestion({
          targetScope: { kind: "user", userId: "user-1" },
          listingId,
        }),
      ).resolves.toMatchObject({ version: "1.1.0" });

      const contentUrl = new URL("https://upload.test/api/upload/files/by-key/content");
      contentUrl.searchParams.set("provider", "database");
      contentUrl.searchParams.set("key", "automations/telegram-test-command.workflow.js");
      const content = await runtime.objects.upload
        .forUser({ userId: "user-1" })
        .fetch(new Request(contentUrl));
      assert(content.ok);
      await expect(content.text()).resolves.toBe(TELEGRAM_TEST_COMMAND_WORKFLOW_V1_1_SOURCE);
    } finally {
      await runtime.cleanup();
    }
  });

  test("revalidates user workspace membership inside the ingestion workflow", async () => {
    let membershipChecks = 0;
    const runtime = await createInMemoryBackofficeRuntime({
      objectFactories: {
        AUTH: () =>
          ({
            hasOrganizationMember: async () => {
              membershipChecks += 1;
              return membershipChecks === 1;
            },
          }) as never,
      },
    });

    try {
      const automations = runtime.objects.automations.forOrg("org-1");
      await automations.requestStaticMarketplacePublications();
      await runtime.drain();

      const listingId = marketplaceListingId({
        ownerScope: { kind: "system" },
        slug: "telegram-test-command",
      });
      const workflowInstanceId = await buildMarketplaceIngestionWorkflowInstanceId({
        targetScope: { kind: "user", userId: "user-1" },
        listingId,
        version: "1.1.0",
      });
      await expect(
        automations.requestMarketplaceIngestion({
          listingId,
          targetScope: { kind: "user", userId: "user-1" },
        }),
      ).resolves.toMatchObject({ state: "requested", workflowInstanceId });

      await runtime.drain();

      const workflows = createWorkflowsRouteCaller({
        object: automations,
      });
      const instance = await workflows("GET", "/:workflowName/instances/:instanceId", {
        pathParams: {
          workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
          instanceId: workflowInstanceId,
        },
      });
      assert(instance.type === "json");
      expect(instance.data.details).toMatchObject({
        status: "errored",
        error: {
          name: "NonRetryableError",
          message: "Marketplace ingestion user target is not a member of the organization.",
        },
      });
      await expect(
        automations.getMarketplaceIngestion({
          targetScope: { kind: "user", userId: "user-1" },
          listingId,
        }),
      ).resolves.toBeNull();
      expect(membershipChecks).toBe(2);
    } finally {
      await runtime.cleanup();
    }
  });

  test("rejects marketplace project targets from another organization", async () => {
    const runtime = await createInMemoryBackofficeRuntime();

    try {
      await expect(
        runtime.objects.automations.forOrg("org-1").requestMarketplaceIngestion({
          listingId: marketplaceListingId({
            ownerScope: { kind: "system" },
            slug: "telegram-test-command",
          }),
          targetScope: { kind: "project", orgId: "org-2", projectId: "project-1" },
        }),
      ).rejects.toThrow("Marketplace ingestion target belongs to another organization.");
    } finally {
      await runtime.cleanup();
    }
  });

  test("returns the failure from an existing marketplace publication workflow", async () => {
    const runtime = await createInMemoryBackofficeRuntime();

    try {
      const listingId = marketplaceListingId({
        ownerScope: { kind: "system" },
        slug: "telegram-test-command",
      });
      const workflowInstanceId = buildMarketplacePublicationWorkflowInstanceId({
        listingId,
        version: "1.0.0",
      });
      const automations = runtime.objects.automations.forOrg("org-1");
      const workflows = createWorkflowsRouteCaller({
        object: automations,
      });
      const created = await workflows("POST", "/:workflowName/instances", {
        pathParams: { workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME },
        body: {
          id: workflowInstanceId,
          params: {
            slug: "missing-entry",
            version: "1.0.0",
          },
        },
      });
      assert(created.type === "json");

      await runtime.drain();

      await expect(automations.requestStaticMarketplacePublications()).resolves.toEqual({
        publications: [
          {
            listingId,
            slug: "telegram-test-command",
            version: "1.0.0",
            workflowInstanceId,
            state: "failed",
            workflowStatus: "errored",
            error: {
              name: "NonRetryableError",
              message: "Static marketplace entry missing-entry@1.0.0 was not found.",
            },
          },
          expect.objectContaining({
            listingId,
            slug: "telegram-test-command",
            version: "1.1.0",
            state: "queued",
            blockedByVersion: "1.0.0",
          }),
        ],
      });
    } finally {
      await runtime.cleanup();
    }
  });
});
