import { describe, expect, test, vi } from "vitest";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { loadAutomationCatalog } from "@/fragno/automation/catalog";

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

describe("createDefaultAutomationFileSystem", () => {
  test("loads the catalog filesystem for system automation scope", async () => {
    const fs = await createFileSystem({
      actor: { type: "system", id: "system" },
      scope: { kind: "system" },
    });

    const catalog = await loadAutomationCatalog(fs);

    expect(catalog.scripts.map((script) => script.absolutePath)).toContain(
      "/system/automations/workspace-file-initialization.workflow.js",
    );
  });

  test("loads the catalog filesystem for user automation scope", async () => {
    const fs = await createFileSystem({
      actor: { type: "automation", id: "automation:event-1" },
      scope: { kind: "user", userId: "user-1" },
    });

    const catalog = await loadAutomationCatalog(fs);

    expect(catalog.scripts.map((script) => script.absolutePath)).toContain(
      "/system/automations/workspace-file-initialization.workflow.js",
    );
  });
});
