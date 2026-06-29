import { describe, expect, test, vi } from "vitest";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { loadAutomationCatalog } from "@/fragno/automation/catalog";
import type { AutomationEvent } from "@/fragno/automation/contracts";

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

const createFileSystem = (execution: BackofficeExecutionContext) =>
  createDefaultAutomationFileSystem({
    objects,
    kernel: new BackofficeKernel({ objects }),
    execution,
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
  test("loads the full catalog filesystem for system automation scope", async () => {
    const fs = await createFileSystem({
      actor: { type: "system", id: "system" },
      scope: { kind: "system" },
    });

    const catalog = await loadAutomationCatalog(fs);

    expect(catalog.scripts.map((script) => script.absolutePath)).toEqual(
      expect.arrayContaining([
        "/system/automations/codemode-types-refresh.workflow.js",
        "/system/automations/project-files-configure.workflow.js",
        "/system/automations/workspace-file-initialization.workflow.js",
      ]),
    );
  });

  test("loads the same system automations for user automation scope", async () => {
    const fs = await createFileSystem({
      actor: { type: "automation", id: "automation:event-1" },
      scope: { kind: "user", userId: "user-1" },
    });

    const catalog = await loadAutomationCatalog(fs);

    expect(catalog.scripts.map((script) => script.absolutePath)).toEqual(
      expect.arrayContaining([
        "/system/automations/codemode-types-refresh.workflow.js",
        "/system/automations/project-files-configure.workflow.js",
        "/system/automations/workspace-file-initialization.workflow.js",
      ]),
    );
  });
});

describe("Automations object scope binding", () => {
  test("rejects events whose scope does not match an already configured object", async () => {
    const runtime = await createInMemoryBackofficeRuntime();

    try {
      const automations = runtime.objects.automations.forOrg("org-1");
      await automations.ingestEvent(scopedEvent("org-1"));

      await expect(automations.ingestEvent(scopedEvent("org-2"))).rejects.toThrow(
        "Automations Durable Object is already bound to a different scope.",
      );
    } finally {
      await runtime.cleanup();
    }
  });
});
