import { assert, describe, expect, test, vi } from "vitest";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeConfig } from "@/backoffice-runtime/runtime-services";
import { loadAutomationCatalog } from "@/fragno/automation/catalog";
import type { AutomationEvent } from "@/fragno/automation/contracts";
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
        ],
      });
    } finally {
      await runtime.cleanup();
    }
  });
});
