import { assert, describe, expect, test, vi } from "vitest";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { TELEGRAM_TEST_COMMAND_WORKFLOW_V1_1_SOURCE } from "@/files/content/telegram-test-command";
import { loadAutomationCatalog } from "@/fragno/automation/catalog";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import {
  buildMarketplaceIngestionWorkflowInstanceId,
  MARKETPLACE_INGEST_WORKFLOW_NAME,
} from "@/fragno/automation/marketplace-ingest-workflow";
import {
  buildMarketplacePublicationWorkflowInstanceId,
  MARKETPLACE_PUBLISH_WORKFLOW_NAME,
} from "@/fragno/automation/marketplace-publish-workflow";
import { createWorkflowsRouteCaller } from "@/fragno/automation/route-callers";
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
    kernel: new BackofficeKernel({ objects }),
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
  actor: {
    scope: "external",
    source: "github",
    type: "user",
    id: "octocat",
  },
  actors: [
    {
      scope: "external",
      source: "github",
      type: "user",
      id: "octocat",
    },
  ],
  subject: { orgId },
});

describe("createDefaultAutomationFileSystem", () => {
  test("loads static and system automation files for system automation scope", async () => {
    const fs = await createFileSystem({
      actor: { type: "system", id: "system" },
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
    const fs = await createFileSystem({
      actor: { type: "automation", id: "automation:event-1" },
      scope: { kind: "user", userId: "user-1" },
    });

    const catalog = await loadAutomationCatalog(fs);

    expect(catalog.scripts.map((script) => script.absolutePath)).toEqual(
      expect.arrayContaining(["/static/automations/project-files-configure.workflow.js"]),
    );
    expect(catalog.scripts.map((script) => script.absolutePath)).not.toContain(
      "/system/automations/workspace-file-initialization.workflow.js",
    );
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
        scope: { kind: "org", orgId: "org-1" },
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
        scope: { kind: "org", orgId: "org-1" },
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
