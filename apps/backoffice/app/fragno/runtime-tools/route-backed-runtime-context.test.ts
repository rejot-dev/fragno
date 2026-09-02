import { beforeEach, describe, expect, test, vi } from "vitest";

import { unrestrictedBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import {
  BackofficeKernel,
  BackofficeUnavailableError,
  noopBackofficeKernelObserver,
} from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createTestAutomationSourceReader } from "@/fragno/automation/test-automation-source-reader.test-utils";

const { readBackofficeAutomationSourceMock } = vi.hoisted(() => ({
  readBackofficeAutomationSourceMock: vi.fn(),
}));

vi.mock("@/fragno/automation/read-backoffice-automation-source", () => ({
  readBackofficeAutomationSource: readBackofficeAutomationSourceMock,
}));

import type { PiRuntime } from "./families/pi-runtime";
import { createRouteBackedRuntimeContext } from "./route-backed-runtime-context";

const createRuntime = (): BackofficeRuntimeServices => {
  const automationsObject = { fetch: async () => new Response() };
  const objects = {
    automations: {
      singleton: () => automationsObject,
      forOrg: () => automationsObject,
      forProject: () => automationsObject,
    },
    cloudflare: {
      singleton: () => {
        throw new BackofficeUnavailableError("CLOUDFLARE is unavailable");
      },
    },
  } as unknown as BackofficeObjectRegistry;

  return {
    objects,
    authorityResolver: unrestrictedBackofficeAuthorityResolver,
    kernelObserver: noopBackofficeKernelObserver,
    adapters: {} as BackofficeRuntimeServices["adapters"],
    config: {
      authEmailVerification: { enabled: false },
      signUpInvitationsEnabled: true,
      bindings: {
        api: false,
        auth: false,
        automations: true,
        billing: false,
        marketplace: false,
        telegram: false,
        otp: false,
        resend: false,
        reson8: false,
        mcp: false,
        upload: false,
        github: false,
        githubWebhookRouter: false,
        cloudflare: true,
        sandbox: false,
      },
    },
  };
};

describe("createRouteBackedRuntimeContext", () => {
  beforeEach(() => {
    readBackofficeAutomationSourceMock.mockReset();
  });

  test("preserves an injected Pi runtime in scoped child contexts", () => {
    const runtime = createRuntime();
    const piRuntime = {} as PiRuntime;
    const context = createRouteBackedRuntimeContext({
      runtime,
      kernel: new BackofficeKernel(runtime),
      execution: createBackofficeSystemExecution({ kind: "system" }),
      pi: { runtime: piRuntime },
    });

    const scoped = context.createBackofficeScopedContext({ kind: "system" });

    expect(scoped.pi?.runtime).toBe(piRuntime);
  });

  test("uses a new workflow source reader for a different scoped context", async () => {
    const runtime = createRuntime();
    const parentBackend = createTestAutomationSourceReader({
      "/workspace/automations/parent.workflow.js": `defineWorkflow({ name: "parent-workflow" }, async () => undefined);`,
    });
    const childBackend = createTestAutomationSourceReader({
      "/workspace/automations/child.workflow.js": `defineWorkflow({ name: "child-workflow" }, async () => undefined);`,
    });
    const parentReadSource = vi.fn(parentBackend);
    const childReadSource = vi.fn(childBackend);
    readBackofficeAutomationSourceMock.mockImplementation(childReadSource);

    const context = createRouteBackedRuntimeContext({
      runtime,
      kernel: new BackofficeKernel(runtime),
      execution: createBackofficeSystemExecution({ kind: "system" }),
      workflowSourceReader: parentReadSource,
    });
    const projectScope = { kind: "project" as const, orgId: "org-1", projectId: "project-1" };
    const scoped = context.createBackofficeScopedContext(projectScope);

    const createWorkflowInstance = scoped.workflow?.runtime.createInstance;
    if (!createWorkflowInstance) {
      throw new Error("Scoped workflow runtime cannot start saved instances.");
    }
    await createWorkflowInstance({
      path: "/workspace/automations/child.workflow.js",
      instanceId: "child-instance",
    }).catch(() => undefined);

    expect(readBackofficeAutomationSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({ scope: projectScope }),
      }),
    );
    expect(childReadSource).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/workspace/automations/child.workflow.js" }),
    );
    expect(parentReadSource).not.toHaveBeenCalled();
  });

  test("reuses the workflow source reader when the scope is unchanged", async () => {
    const runtime = createRuntime();
    const sourceReader = createTestAutomationSourceReader({
      "/workspace/automations/same-scope.workflow.js": `defineWorkflow({ name: "same-scope-workflow" }, async () => undefined);`,
    });
    const readSource = vi.fn(sourceReader);
    const scope = { kind: "system" as const };
    const context = createRouteBackedRuntimeContext({
      runtime,
      kernel: new BackofficeKernel(runtime),
      execution: createBackofficeSystemExecution(scope),
      workflowSourceReader: readSource,
    });
    const scoped = context.createBackofficeScopedContext({ ...scope });

    const createWorkflowInstance = scoped.workflow?.runtime.createInstance;
    if (!createWorkflowInstance) {
      throw new Error("Scoped workflow runtime cannot start saved instances.");
    }
    await createWorkflowInstance({
      path: "/workspace/automations/same-scope.workflow.js",
      instanceId: "same-scope-instance",
    }).catch(() => undefined);

    expect(readSource).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/workspace/automations/same-scope.workflow.js" }),
    );
    expect(readBackofficeAutomationSourceMock).not.toHaveBeenCalled();
  });

  test("keeps the context available when the Cloudflare singleton cannot be resolved", () => {
    const runtime = createRuntime();
    const context = createRouteBackedRuntimeContext({
      runtime,
      kernel: new BackofficeKernel(runtime),
      execution: createBackofficeSystemExecution({ kind: "system" }),
    });

    expect(context.cloudflare).toBeNull();
    expect(context.event).not.toBeNull();
    expect(context.automations).not.toBeNull();
  });
});
