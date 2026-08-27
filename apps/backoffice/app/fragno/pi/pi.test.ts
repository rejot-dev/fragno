import { describe, expect, test, assert } from "vitest";

import { NonRetryableError } from "@fragno-dev/workflows/workflow";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { InMemoryAdapter } from "@fragno-dev/db";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import { unavailableBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import type { FileSearchMatch } from "@/file-collection/file-collection";
import { createBackofficeStaticFileCollection } from "@/files/content/static";
import { EMPTY_BASH_HOST_CONTEXT } from "@/fragno/runtime-tools/bash-host.test-utils";
import { createUnavailableAutomationRouterRuntime } from "@/fragno/runtime-tools/families/automations-routing";

import { createBackofficeSystemStateBackend } from "../codemode/state-backend";
import { createTestStateBackend, MemoryUploadObject } from "../codemode/state-backend.test-utils";
import { createBackofficePiSessionExecution, createPiRuntimeDefinition } from "./pi-runtime";
import { BACKOFFICE_PI_WORKFLOW_NAME } from "./pi-shared";
import { loadBackofficePiSkills } from "./pi-skills";
import {
  createPiToolFactory,
  createPiToolRegistry,
  formatSearchMatches,
  type PiRuntimeToolContext,
} from "./pi-tools";

const createMockRuntimeToolContext = (
  stateBackend = createTestStateBackend(),
): PiRuntimeToolContext => ({
  ...EMPTY_BASH_HOST_CONTEXT,
  stateBackend,
  automation: null,
  automations: {
    runtime: {
      ...createUnavailableAutomationRouterRuntime(),
      get: async () => {
        throw new Error("not available in test");
      },
      set: async () => {
        throw new Error("not available in test");
      },
      delete: async () => {
        throw new Error("not available in test");
      },
      list: async () => {
        throw new Error("not available in test");
      },
    },
  },
  otp: {
    runtime: {
      createClaim: async () => {
        throw new Error("not available in test");
      },
    },
  },
  pi: {
    runtime: {
      createSession: async () => {
        throw new Error("not available in test");
      },
      getSession: async () => {
        throw new Error("not available in test");
      },
      listSessions: async () => {
        throw new Error("not available in test");
      },
      runTurn: async () => {
        throw new Error("not available in test");
      },
    },
  },
  reson8: {
    runtime: {
      transcribePrerecorded: async () => {
        throw new Error("not available in test");
      },
    },
  },
  resend: {
    runtime: {
      listThreads: async () => {
        throw new Error("not available in test");
      },
      getThread: async () => {
        throw new Error("not available in test");
      },
      listThreadMessages: async () => {
        throw new Error("not available in test");
      },
      getThreadSnapshot: async () => {
        throw new Error("not available in test");
      },
      replyToThread: async () => {
        throw new Error("not available in test");
      },
    },
  },
  telegram: {
    runtime: {
      getFile: async () => {
        throw new Error("not available in test");
      },
      downloadFile: async () => {
        throw new Error("not available in test");
      },
      sendMessage: async () => {
        throw new Error("not available in test");
      },
      sendChatAction: async () => {
        throw new Error("not available in test");
      },
      editMessage: async () => {
        throw new Error("not available in test");
      },
    },
  },
});

describe("Backoffice Pi fragment", () => {
  test("authorizes billing organizations for immediate and deferred user sessions", async () => {
    const baseContext = createContext();
    const scope = { kind: "user" as const, userId: "test-user" };
    const execution = createBackofficeUserExecution({
      scope,
      userId: scope.userId,
      verifiedRequestAuthority: {
        role: "user",
        organizationId: "org-1",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    const kernel = new BackofficeKernel({
      authorityResolver: {
        async resolvePrincipalPermissions({ execution: currentExecution }) {
          if (
            currentExecution.scope.kind === "user" ||
            (currentExecution.scope.kind === "org" && currentExecution.scope.orgId === "org-1")
          ) {
            return [BACKOFFICE_PERMISSION.pi.modify];
          }
          return [];
        },
        async resolveActorCapabilityGrants() {
          return [];
        },
      },
      kernelObserver: noopBackofficeKernelObserver,
    });
    const context = { ...baseContext, scope, execution, kernel };
    const adapter = new InMemoryAdapter({ idSeed: "pi-user-billing-test" });
    const definition = createPiRuntimeDefinition({
      scope,
      kernel: context.kernel,
      apiKeys: { openai: "test-key" },
      runtimeToolContext: createMockRuntimeToolContext(),
      codemode: {
        execute: async () => {
          throw new Error("codemode not available in test");
        },
      },
    });
    const workflowsFragment = createWorkflowsFragment(
      { workflows: definition.workflows, runtime: defaultFragnoRuntime },
      { databaseAdapter: adapter },
    );
    const piFragment = definition.createFragment({
      databaseAdapter: adapter,
      workflows: workflowsFragment.services,
    });
    const createRequest = (billingOrganizationId?: string) =>
      new Request(`http://test.local/api/pi/workflows/${BACKOFFICE_PI_WORKFLOW_NAME}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metadata: {
            model: { provider: "openai", name: "gpt-5.6-luna" },
            ...(billingOrganizationId
              ? { __backofficeBillingOrganizationId: billingOrganizationId }
              : {}),
          },
          input: {},
        }),
      });

    const missingResponse = await piFragment.handler(createRequest(), {
      requestContext: execution,
    });
    assert(missingResponse.status === 400);

    const unavailableResponse = await piFragment.handler(createRequest("org-2"), {
      requestContext: execution,
    });
    assert(unavailableResponse.status === 403);

    const response = await piFragment.handler(createRequest("org-1"), {
      requestContext: execution,
    });
    assert(response.ok);
    await expect(response.json()).resolves.toMatchObject({
      metadata: { __backofficeBillingOrganizationId: "org-1" },
    });

    const deferredResponse = await piFragment.handler(createRequest("org-1"), {
      requestContext: createBackofficeUserExecution({
        scope,
        userId: scope.userId,
      }),
    });
    assert(deferredResponse.ok);
  });

  test("rejects unknown model names before creating the session", async () => {
    const context = createContext();
    const adapter = new InMemoryAdapter({ idSeed: "pi-invalid-model-test" });
    const definition = createPiRuntimeDefinition({
      scope: { kind: "org", orgId: "acme-org" },
      kernel: context.kernel,
      apiKeys: { openai: "test-key" },
      runtimeToolContext: createMockRuntimeToolContext(),
      codemode: {
        execute: async () => {
          throw new Error("codemode not available in test");
        },
      },
    });

    const workflowsFragment = createWorkflowsFragment(
      { workflows: definition.workflows, runtime: defaultFragnoRuntime },
      { databaseAdapter: adapter },
    );
    const piFragment = definition.createFragment({
      databaseAdapter: adapter,
      workflows: workflowsFragment.services,
    });

    const response = await piFragment.handler(
      new Request(`http://test.local/api/pi/workflows/${BACKOFFICE_PI_WORKFLOW_NAME}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metadata: { model: { provider: "openai", name: "bla" } },
          input: {},
        }),
      }),
      { requestContext: context.execution },
    );

    assert(response.status === 400);
    await expect(response.json()).resolves.toMatchObject({
      code: "WORKFLOW_PARAMS_INVALID",
      message: "Model openai/bla not found.",
    });

    const listResponse = await workflowsFragment.callServices(() =>
      workflowsFragment.services.listInstances({
        workflowName: BACKOFFICE_PI_WORKFLOW_NAME,
      }),
    );
    expect(listResponse.instances).toEqual([]);
  });
});

describe("Backoffice Pi search output", () => {
  test("formats matches in file blocks", () => {
    const output = formatSearchMatches([
      {
        path: "workspace/src/orders.ts",
        line: 12,
        column: 7,
        text: "createOrder",
        lineText: "const createOrder = () => undefined;",
        contextBefore: [],
        contextAfter: [],
      },
      {
        path: "workspace/src/routes.ts",
        line: 31,
        column: 15,
        text: "createOrder",
        lineText: "  return await createOrder(input);",
        contextBefore: [],
        contextAfter: [],
      },
    ]);

    expect(output).toMatchInlineSnapshot(`
      "workspace/src/orders.ts
      > 12:7 | const createOrder = () => undefined;

      workspace/src/routes.ts
      > 31:15 |   return await createOrder(input);"
    `);
  });

  test("paginates the combined scoped and static match budget", async () => {
    const context = createContext();
    const sessionId = "search-pagination";
    const stateBackend = createTestStateBackend({
      upload: new MemoryUploadObject({
        "upload-a.ts": "needle",
        "upload-b.ts": "needle",
      }),
      staticFiles: {
        "static-a.ts": "needle",
        "static-b.ts": "needle",
      },
    });
    const tools = await createPiToolFactory({
      runtimeToolContext: createMockRuntimeToolContext(stateBackend),
    })({ sessionId, execution: context.execution });
    assert(tools.search, "search tool should be configured");

    const firstPage = await tools.search.execute("search-1", {
      query: "needle",
      maxMatches: 3,
    } as never);
    const firstDetails = firstPage.details as {
      matches: FileSearchMatch[];
      cursor: { scope?: string; static?: string };
    };
    expect(firstDetails.matches).toHaveLength(3);
    expect(firstDetails.cursor.scope).toBeUndefined();
    expect(firstDetails.cursor.static).toBeDefined();

    const secondPage = await tools.search.execute("search-2", {
      query: "needle",
      maxMatches: 3,
      cursor: firstDetails.cursor,
    } as never);
    const secondDetails = secondPage.details as {
      matches: FileSearchMatch[];
      cursor: { scope?: string; static?: string };
    };
    expect(secondDetails.matches).toHaveLength(1);
    assert(secondDetails.matches[0]?.path === "/static/static-b.ts");
    expect(secondDetails.cursor).toEqual({});
  });

  test("formats and merges surrounding context", () => {
    const output = formatSearchMatches([
      {
        path: "workspace/src/orders.ts",
        line: 12,
        column: 7,
        text: "createOrder",
        lineText: "const createOrder = () => undefined;",
        contextBefore: ["export type Order = {};", ""],
        contextAfter: ["", "// Public API"],
      },
      {
        path: "workspace/src/orders.ts",
        line: 15,
        column: 10,
        text: "createOrder",
        lineText: "export { createOrder };",
        contextBefore: ["// Public API"],
        contextAfter: [],
      },
      {
        path: "workspace/src/orders.ts",
        line: 40,
        column: 3,
        text: "createOrder",
        lineText: "  createOrder();",
        contextBefore: ["function seed() {"],
        contextAfter: ["}"],
      },
    ]);

    expect(output).toBe(
      [
        "workspace/src/orders.ts",
        "  10 | export type Order = {};",
        "  11 | ",
        "> 12:7 | const createOrder = () => undefined;",
        "  13 | ",
        "  14 | // Public API",
        "> 15:10 | export { createOrder };",
        "",
        "workspace/src/orders.ts",
        "  39 | function seed() {",
        "> 40:3 |   createOrder();",
        "  41 | }",
      ].join("\n"),
    );
  });
});

describe("Backoffice Pi execution", () => {
  test("treats invalid session actor metadata as non-retryable", () => {
    try {
      createBackofficePiSessionExecution({ kind: "user", userId: "user-1" }, null);
      assert.fail("expected invalid actor metadata to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NonRetryableError);
      expect(error).toMatchObject({
        name: "PiSessionActorMetadataInvalidError",
        message: "PI_SESSION_ACTOR_METADATA_INVALID",
      });
    }
  });

  test("uses the system state backend when Upload-backed state is unavailable", async () => {
    const sessionId = "system-session";
    const execution = createBackofficeUserExecution({
      scope: { kind: "system" },
      userId: "admin-1",
    });
    const runtimeToolContext = createMockRuntimeToolContext(
      createBackofficeSystemStateBackend({
        staticFileCollection: createBackofficeStaticFileCollection(() => ({
          "SYSTEM.md": "Static guidance",
        })),
      }),
    );
    const createTools = createPiToolFactory({ runtimeToolContext });

    const tools = await createTools({ sessionId, execution });
    await expect(
      tools.read?.execute("read-system-file", { path: "/system/README.md" }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("admin-only system-scope") }],
    });
    await expect(
      tools.search?.execute("search-system-files", {
        query: "admin-only system-scope",
        glob: "/system/**",
      }),
    ).resolves.toMatchObject({
      details: {
        matches: [{ path: "/system/README.md" }],
      },
    });
  });

  test("builds runtime tools from the session creator execution", async () => {
    const sessionExecution = createBackofficeUserExecution({
      scope: { kind: "org", orgId: "acme-org" },
      userId: "session-creator",
    });
    let receivedExecution: typeof sessionExecution | undefined;
    let receivedMetadata: Record<string, unknown> | null | undefined;
    let contextResolutionCount = 0;
    const sessionId = "session-execution";
    const createTools = createPiToolFactory({
      runtimeToolContext: (execution, metadata) => {
        contextResolutionCount += 1;
        receivedExecution = execution;
        receivedMetadata = metadata;
        return createMockRuntimeToolContext();
      },
    });

    await createTools({
      sessionId,
      execution: sessionExecution,
      metadata: { __backofficeBillingOrganizationId: "org-1" },
    });

    expect(receivedExecution).toEqual(sessionExecution);
    expect(receivedMetadata).toEqual({ __backofficeBillingOrganizationId: "org-1" });
    expect(contextResolutionCount).toBe(1);
  });
});

describe("Backoffice Pi skills", () => {
  test("loads starter skills from Backoffice state", async () => {
    const skills = await loadBackofficePiSkills(createTestStateBackend());

    expect(Object.keys(skills)).toEqual(
      expect.arrayContaining([
        "building-automations",
        "generating-backoffice-uis",
        "using-prepared-uploads",
      ]),
    );
    expect(skills["building-automations"]).toMatchObject({
      location: "/static/skills/building-automations/SKILL.md",
      directory: "/static/skills/building-automations",
    });
    expect(skills["building-automations"]?.body).toContain("events.catalogList");
    expect(skills["generating-backoffice-uis"]).toMatchObject({
      location: "/static/skills/generating-backoffice-uis/SKILL.md",
      directory: "/static/skills/generating-backoffice-uis",
    });
    expect(skills["generating-backoffice-uis"]?.body).toContain("## Result contract");
  });

  test("loads static skills when the workspace skills directory is absent", async () => {
    const state = createTestStateBackend({
      staticFiles: {
        "skills/static-only/SKILL.md": `---
name: static-only
description: Static fallback skill.
---

# Static fallback
`,
      },
    });

    await expect(loadBackofficePiSkills(state)).resolves.toMatchObject({
      "static-only": {
        name: "static-only",
        location: "/static/skills/static-only/SKILL.md",
      },
    });
  });

  test("skips malformed skill files while loading remaining static and workspace skills", async () => {
    const state = createTestStateBackend({
      staticFiles: {
        "skills/static-valid/SKILL.md": `---
name: static-valid
description: Valid static skill.
---

# Static
`,
      },
      upload: new MemoryUploadObject({
        "skills/malformed/SKILL.md": `---
name: malformed
---

# Missing description
`,
        "skills/workspace-valid/SKILL.md": `---
name: workspace-valid
description: Valid workspace skill.
---

# Workspace
`,
      }),
    });

    const skills = await loadBackofficePiSkills(state);

    expect(skills).toMatchObject({
      "static-valid": { name: "static-valid" },
      "workspace-valid": { name: "workspace-valid" },
    });
    expect(skills.malformed).toBeUndefined();
  });

  test("reflects skills from the Upload-backed workspace", async () => {
    const state = createTestStateBackend({
      upload: new MemoryUploadObject({
        "skills/custom/SKILL.md": `---
name: custom
description: Use custom collection skill.
---

# Custom Skill

Filesystem-defined instructions.
`,
      }),
    });

    const skills = await loadBackofficePiSkills(state);

    expect(Object.keys(skills)).toEqual(expect.arrayContaining(["custom"]));
    expect(skills.custom).toMatchObject({
      name: "custom",
      description: "Use custom collection skill.",
      location: "/workspace/skills/custom/SKILL.md",
    });
  });

  test("exposes codemode, declaration-reading, and file-search tools", () => {
    const tools = createPiToolRegistry({ execution: createContext().execution });

    expect(Object.keys(tools)).toEqual(["read", "search", "execCodeMode"]);
  });

  test("exposes a read tool that can load starter skill files", async () => {
    const sessionId = "session-skill-read";
    const tools = createPiToolRegistry({
      execution: createContext().execution,
      runtimeToolContext: createMockRuntimeToolContext(),
    });

    const readFactory = tools.read;
    if (typeof readFactory !== "function") {
      throw new Error("Expected read to be registered as a factory.");
    }

    const readTool = await readFactory({
      session: { id: sessionId },
      turnId: "turn-1",
      toolConfig: null,
      messages: [],
    } as never);

    assert(readTool.name === "read");
    const result = await readTool.execute("tool-call-skill-1", {
      path: "/static/skills/building-automations/SKILL.md",
      offset: 1,
      limit: 8,
    } as never);

    expect(result.details).toMatchObject({
      path: "/static/skills/building-automations/SKILL.md",
      offset: 1,
      limit: 8,
    });
    const content = result.content[0];
    assert(content?.type === "text");
    expect(content?.type === "text" ? content.text : "").toContain("name: building-automations");
  });
});

const createContext = () => ({
  kernel: new BackofficeKernel({
    authorityResolver: unavailableBackofficeAuthorityResolver,
    kernelObserver: noopBackofficeKernelObserver,
  }),
  execution: createBackofficeUserExecution({
    scope: { kind: "org", orgId: "acme-org" },
    userId: "test-user",
  }),
});
