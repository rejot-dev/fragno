import { describe, expect, test, vi } from "vitest";

import { Bash, InMemoryFs } from "just-bash";
import { z } from "zod";

import type { BackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import {
  BackofficeKernel,
  type BackofficeKernelAction,
  type BackofficeKernelObserver,
} from "@/backoffice-runtime/kernel";
import type { BackofficePermissionRequirement } from "@/backoffice-runtime/permissions";

import {
  createBackofficeBashCommands,
  defineBackofficeRuntimeTool,
  executeBackofficeRuntimeTool,
  type BackofficeToolContext,
} from "./runtime-tools";

const createToolContext = ({
  grants,
  observer,
}: {
  grants: readonly BackofficePermissionRequirement[];
  observer?: BackofficeKernelObserver;
}): BackofficeToolContext => {
  const authorityResolver: BackofficeAuthorityResolver = {
    async resolvePrincipalPermissions() {
      return grants;
    },
    async resolveActorCapabilityGrants() {
      return grants;
    },
  };
  const kernel = new BackofficeKernel({
    authorityResolver,
    kernelObserver:
      observer ??
      ({
        async runAction(_action, execute) {
          await execute();
        },
      } satisfies BackofficeKernelObserver),
  });
  const execution = createBackofficeUserExecution({
    scope: { kind: "org", orgId: "org-1" },
    userId: "user-1",
  });
  let context: BackofficeToolContext;
  context = {
    runtimes: {},
    execution,
    kernel,
    createScopedContext: () => context,
  };
  return context;
};

describe("runtime tool authorization", () => {
  test("requires every declared permission before executing a tool", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const tool = defineBackofficeRuntimeTool({
      id: "internal.test.manage",
      namespace: "internal",
      name: "testManage",
      description: "Test internal permissions.",
      requiredPermissions: ["read", "manage"],
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute,
    });

    await expect(
      executeBackofficeRuntimeTool(
        tool,
        {},
        createToolContext({ grants: [{ namespace: "internal", permission: "read" }] }),
      ),
    ).rejects.toMatchObject({ reason: "principal-permission-denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("uses the authorization namespace and resource declared by the tool", async () => {
    const authorized: BackofficeKernelAction[] = [];
    const observer: BackofficeKernelObserver = {
      async observeAuthorization(action) {
        authorized.push(action);
      },
      async runAction(_action, execute) {
        await execute();
      },
    };
    const tool = defineBackofficeRuntimeTool({
      id: "automations.identity.resolve",
      namespace: "automations",
      authorizationNamespace: "identity",
      name: "identityResolve",
      description: "Resolve an identity.",
      requiredPermissions: ["resolve"],
      inputSchema: z.object({ subjectId: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      getResource: (input) => ({ subjectId: input.subjectId }),
      execute: async () => ({ ok: true }),
    });

    await expect(
      executeBackofficeRuntimeTool(
        tool,
        { subjectId: "subject-1" },
        createToolContext({
          grants: [{ namespace: "identity", permission: "resolve" }],
          observer,
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(authorized).toMatchObject([
      {
        operation: { namespace: "identity", permission: "resolve" },
        resource: { subjectId: "subject-1" },
      },
    ]);
  });

  test("authorizes custom Bash adapters before invoking them", async () => {
    const executeBashAdapter = vi.fn(async () => ({ stdout: "executed\n", exitCode: 0 }));
    const tool = defineBackofficeRuntimeTool({
      id: "internal.test.bash",
      namespace: "internal",
      name: "testBash",
      description: "Test custom Bash adapter authorization.",
      requiredPermissions: ["manage"],
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
      adapters: {
        bash: {
          command: "internal.test.bash",
          help: { summary: "Test command.", options: [], examples: [] },
          parse: () => ({}),
          execute: executeBashAdapter,
        },
      },
    });
    const bash = new Bash({
      fs: new InMemoryFs(),
      customCommands: createBackofficeBashCommands({
        tools: [tool],
        context: createToolContext({ grants: [] }),
        commandCallsResult: [],
      }),
    });

    await expect(bash.exec("internal.test.bash")).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("required permission"),
    });
    expect(executeBashAdapter).not.toHaveBeenCalled();
  });
});
