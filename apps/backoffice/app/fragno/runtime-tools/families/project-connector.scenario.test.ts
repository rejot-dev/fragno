import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { projectConnectorConnectionSchema } from "@fragno-dev/project-connector-fragment/contracts";

import {
  createBackofficeServiceExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { runProjectConnectorScenario } from "./project-connector-scenario.test-utils";

test("user-scoped codemode verifies OAuth before SQLite bindings, profiles, and provider actions become usable", async () => {
  await runProjectConnectorScenario((gateway) => ({
    name: "Connector verified Gmail flow through real SQLite and HTTP",
    setup: ({ given }) => [
      given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
    ],
    steps: ({ when, then }) => [
      when.codemode.run({
        scope: { kind: "org", orgId: "org-1" },
        label: "discover the configured provider and start Gmail consent",
        code: `async () => {
          const connector = context.user("user-1").connector;
          const discovery = await connector.listProviderConfigs();
          const provider = discovery.providerConfigs.find((config) => config.service === "gmail");
          if (!provider) throw new Error("Gmail is not configured");
          const actions = await connector.listProviderActions({ providerConfigId: provider.id });
          if (!actions.actionIds.includes("gmail.search_threads")) throw new Error("Gmail search is not available");
          return await connector.connect({ providerConfigId: provider.id, connectionName: "work" });
        }`,
        assertToolCalls: [
          "connector.providers.list",
          "connector.providers.actions",
          "connector.connect",
        ],
      }),
      then.assert(
        "only the ID-backed scope and server-selected callback reach the gateway",
        async (ctx) => {
          const request = projectConnectorConnectionSchema.parse(
            ctx.codemodeRuns.at(-1)?.result.result,
          );
          expect(gateway.links).toEqual([
            {
              userId: "user:user-1",
              service: "gmail",
              providerConfigId: "gmail-provider",
              alias: "work",
              returnUri: "https://example.com/api/connector/user%3Auser-1/oauth/callback",
            },
          ]);
          const pending = await ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: "check before consent",
            code: `async () => { const connector = context.user("user-1").connector; return { connection: await connector.refreshConnection({ requestId: ${JSON.stringify(request.id)} }), accounts: await connector.listAccounts() }; }`,
          });
          expect(pending.result).toMatchObject({
            connection: { state: { status: "initiated" } },
            accounts: { accounts: [], hasNextPage: false },
          });
          gateway.authorize(request.id, "gmail-account");
          const connected = await ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: "verify consent and provider identity",
            code: `async () => { const connector = context.user("user-1").connector; return { connection: await connector.refreshConnection({ requestId: ${JSON.stringify(request.id)} }), accounts: await connector.listAccounts(), profile: await connector.getProfile({ accountId: "gmail-account" }) }; }`,
          });
          expect(connected.result).toMatchObject({
            connection: { state: { status: "connected", connectedAccountId: "gmail-account" } },
            accounts: { accounts: [{ id: "gmail-account", externalUserId: "user:user-1" }] },
            profile: { profile: { email: "gmail-user@example.test" } },
          });
          await ctx.runtime.restartObject({
            binding: "PROJECT_CONNECTOR",
            scope: { kind: "user", userId: "user-1" },
          });
          const restored = await ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: "read bindings after object restart",
            code: 'async () => await context.user("user-1").connector.listAccounts()',
          });
          expect(restored.result).toMatchObject({
            accounts: [{ id: "gmail-account", externalUserId: "user:user-1" }],
          });
          const execution = await ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: "execute explicit read-only action",
            code: 'async () => await context.user("user-1").connector.executeAction({ accountId: "gmail-account", actionId: "gmail.search_threads", input: { query: "is:unread" } })',
          });
          expect(execution.result).toMatchObject({
            executionId: "execution-1",
            actionId: "gmail.search_threads",
            output: { threads: [], query: "is:unread" },
          });
          expect(gateway.executions).toEqual([
            {
              externalUserId: "user:user-1",
              providerConfigId: "gmail-provider",
              connectedAccountId: "gmail-account",
              input: { query: "is:unread" },
            },
          ]);
          gateway.control.actionFailure = "text";
          await expect(
            ctx.runCodemode({
              scope: { kind: "org", orgId: "org-1" },
              label: "provider failure must not retry an action",
              code: 'async () => await context.user("user-1").connector.executeAction({ accountId: "gmail-account", actionId: "gmail.search_threads", input: {} })',
            }),
          ).rejects.toThrow("provider_error");
          expect(gateway.executions).toHaveLength(2);
        },
      ),
    ],
  }));
});

test("Connector bindings are isolated between user owners", async () => {
  await runProjectConnectorScenario((gateway) => ({
    name: "Connector user isolation",
    setup: ({ given }) => [
      given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
    ],
    steps: ({ then }) => [
      then.assert("one user cannot read or refresh another user's binding", async (ctx) => {
        const started = await ctx.runCodemode({
          scope: { kind: "org", orgId: "org-1" },
          label: "start user OAuth",
          code: 'async () => await context.user("user-1").connector.connect({ service: "gmail", connectionName: "personal" })',
        });
        const request = projectConnectorConnectionSchema.parse(started.result);
        gateway.authorize(request.id, "private-account");
        await ctx.runCodemode({
          scope: { kind: "org", orgId: "org-1" },
          label: "bind user account",
          code: `async () => await context.user("user-1").connector.refreshConnection({ requestId: ${JSON.stringify(request.id)} })`,
        });

        const accounts = await ctx.runCodemode({
          scope: { kind: "org", orgId: "org-1" },
          label: "list user-owned accounts",
          code: 'async () => ({ owner: await context.user("user-1").connector.listAccounts(), other: await context.user("user-2").connector.listAccounts() })',
        });
        expect(accounts.result).toMatchObject({
          owner: { accounts: [{ id: "private-account", externalUserId: "user:user-1" }] },
          other: { accounts: [] },
        });
        await expect(
          ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: "reject another user's request",
            code: `async () => await context.user("user-2").connector.refreshConnection({ requestId: ${JSON.stringify(request.id)} })`,
          }),
        ).rejects.toThrow("Connection request not found");
        expect(gateway.executions).toEqual([]);
      }),
    ],
  }));
});

test("Connector bash commands use the same user-owned fragment as codemode", async () => {
  await runProjectConnectorScenario((gateway) => ({
    name: "Connector runtime bash commands",
    setup: ({ given }) => [
      given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
    ],
    steps: ({ then }) => [
      then.assert(
        "generated commands authorize, persist, and execute through the route caller",
        async (ctx) => {
          const execution = createBackofficeServiceExecution({
            scope: { kind: "user", userId: "user-1" },
            service: { type: "automation", id: "connector-shell" },
          });
          const { bash } = createInteractiveBashHost({
            context: createCodemodeRouteBackedRuntimeContext({
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution,
              billingOrganizationId: null,
            }),
          });
          const providerHelp = await bash.exec("connector.providers.list --help");
          expect(providerHelp.exitCode, providerHelp.stderr).toBe(0);
          expect(providerHelp.stdout).toContain("OAuth provider configurations");
          const overview = await bash.exec("connector.providers.list");
          expect(overview.exitCode, overview.stderr).toBe(0);
          assert(
            overview.stdout ===
              "Project: project-1\nOAuth provider configurations (1):\n- gmail-provider: Work Gmail (gmail) | proxy: no\n",
            overview.stdout,
          );
          expect(overview.stdout).not.toContain("gmail.search_threads");
          const explicitText = await bash.exec("connector.providers.list --format text");
          expect(explicitText.exitCode, explicitText.stderr).toBe(0);
          expect(explicitText.stdout).toBe(overview.stdout);
          const printedProject = await bash.exec("connector.providers.list --print project-id");
          expect(printedProject.exitCode, printedProject.stderr).toBe(0);
          assert(printedProject.stdout === "project-1\n", printedProject.stdout);
          const discovered = await bash.exec("connector.providers.list --format json");
          expect(discovered.exitCode, discovered.stderr).toBe(0);
          expect(JSON.parse(discovered.stdout)).toEqual({
            projectId: "project-1",
            providerConfigs: [
              {
                id: "gmail-provider",
                service: "gmail",
                displayName: "Work Gmail",
                callbackUrl: "https://connector.example/oauth/callback",
                effectiveScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
                proxyAvailable: false,
              },
            ],
          });
          expect(discovered.stdout).not.toContain("test-project-key");
          expect(discovered.stdout).not.toContain("actionIds");
          const providerActionsHelp = await bash.exec("connector.providers.actions --help");
          expect(providerActionsHelp.exitCode, providerActionsHelp.stderr).toBe(0);
          expect(providerActionsHelp.stdout).toContain("provider-config-id");
          const providerActions = await bash.exec(
            "connector.providers.actions --provider-config-id gmail-provider",
          );
          expect(providerActions.exitCode, providerActions.stderr).toBe(0);
          assert(
            providerActions.stdout ===
              "Project: project-1\nProvider configuration: gmail-provider\nAction IDs (1):\n- gmail.search_threads\n",
            providerActions.stdout,
          );
          const actionIds = await bash.exec(
            "connector.providers.actions --provider-config-id gmail-provider --format json",
          );
          expect(actionIds.exitCode, actionIds.stderr).toBe(0);
          expect(JSON.parse(actionIds.stdout)).toEqual({
            projectId: "project-1",
            providerConfigId: "gmail-provider",
            actionIds: ["gmail.search_threads"],
          });
          const printedActions = await bash.exec(
            "connector.providers.actions --provider-config-id gmail-provider --print action-ids",
          );
          expect(printedActions.exitCode, printedActions.stderr).toBe(0);
          assert(printedActions.stdout === '["gmail.search_threads"]\n', printedActions.stdout);
          const unknownProvider = await bash.exec(
            "connector.providers.actions --provider-config-id unknown",
          );
          expect(unknownProvider.exitCode).not.toBe(0);
          expect(unknownProvider.stderr).toContain("Provider configuration not found");
          const readsBeforeMissingSelector = gateway.control.discoveryReads;
          const missingSelector = await bash.exec("connector.providers.actions");
          expect(missingSelector.exitCode).not.toBe(0);
          expect(missingSelector.stderr).toContain("Missing required option --provider-config-id");
          assert(gateway.control.discoveryReads === readsBeforeMissingSelector);
          expect(gateway.links).toEqual([]);
          expect(gateway.executions).toEqual([]);
          const help = await bash.exec("connector.connect --help");
          expect(help.exitCode, help.stderr).toBe(0);
          expect(help.stdout).toContain("browser consent");
          const started = await bash.exec(
            "connector.connect --service gmail --connection-name work --format json",
          );
          assert(started.exitCode === 0, started.stderr);
          const request = projectConnectorConnectionSchema.parse(JSON.parse(started.stdout));
          gateway.authorize(request.id, "shell-account");
          const refreshed = await bash.exec(
            `connector.connections.refresh --request-id ${request.id} --format json`,
          );
          expect(refreshed.exitCode, refreshed.stderr).toBe(0);
          expect(JSON.parse(refreshed.stdout)).toMatchObject({
            state: { status: "connected", connectedAccountId: "shell-account" },
          });
          const listed = await bash.exec("connector.accounts.list --format json");
          expect(listed.exitCode, listed.stderr).toBe(0);
          expect(JSON.parse(listed.stdout)).toMatchObject({ accounts: [{ id: "shell-account" }] });
          const profile = await bash.exec(
            "connector.accounts.profile --account-id shell-account --format json",
          );
          expect(profile.exitCode, profile.stderr).toBe(0);
          expect(JSON.parse(profile.stdout)).toMatchObject({
            profile: { email: "gmail-user@example.test" },
          });
          const action = await bash.exec(
            'connector.actions.execute --account-id shell-account --action-id gmail.search_threads --input-json \'{"query":"is:unread"}\' --format json',
          );
          expect(action.exitCode, action.stderr).toBe(0);
          expect(JSON.parse(action.stdout)).toMatchObject({ output: { query: "is:unread" } });
          const injected = await bash.exec(
            "connector.connect --service gmail --connection-name attacker --return-uri https://attacker.example",
          );
          expect(injected.exitCode).not.toBe(0);
          expect(injected.stderr).toContain("does not accept option --return-uri");
          expect(gateway.links).toHaveLength(1);
          const [provider] = gateway.providerConfigs;
          assert(provider);
          provider.actionIds.splice(0);
          const emptyActions = await bash.exec(
            "connector.providers.actions --provider-config-id gmail-provider",
          );
          expect(emptyActions.exitCode, emptyActions.stderr).toBe(0);
          assert(
            emptyActions.stdout ===
              "Project: project-1\nProvider configuration: gmail-provider\nNo action IDs available.\n",
            emptyActions.stdout,
          );
          gateway.providerConfigs.splice(0);
          const emptyOverview = await bash.exec("connector.providers.list");
          expect(emptyOverview.exitCode, emptyOverview.stderr).toBe(0);
          assert(
            emptyOverview.stdout ===
              "Project: project-1\nNo OAuth provider configurations available.\n",
            emptyOverview.stdout,
          );
          const emptyOverviewJson = await bash.exec("connector.providers.list --format json");
          expect(emptyOverviewJson.exitCode, emptyOverviewJson.stderr).toBe(0);
          expect(JSON.parse(emptyOverviewJson.stdout)).toEqual({
            projectId: "project-1",
            providerConfigs: [],
          });
        },
      ),
    ],
  }));
});

test("runtime permission failures and unavailable configuration do not contact the provider", async () => {
  await runProjectConnectorScenario((gateway) => ({
    name: "Connector permissions stop side effects",
    setup: ({ given }) => [
      given.auth.user({ id: "member-1", email: "member@example.test" }),
      given.auth.organization({
        id: "org-1",
        slug: "ada-labs",
        name: "Ada Labs",
        ownerUserId: "member-1",
      }),
    ],
    steps: ({ then }) => [
      then.assert("kernel permissions are checked before OAuth or actions", async (ctx) => {
        const execution = createBackofficeUserExecution({
          scope: { kind: "user", userId: "member-1" },
          userId: "member-1",
        });
        const { bash } = createInteractiveBashHost({
          context: createCodemodeRouteBackedRuntimeContext({
            runtime: ctx.runtime.services,
            kernel: new BackofficeKernel(ctx.runtime.services),
            execution,
            billingOrganizationId: null,
          }),
        });
        const discovery = await bash.exec("connector.providers.list");
        expect(discovery.exitCode).not.toBe(0);
        expect(discovery.stderr).toContain("connector.providers.read");
        const providerActions = await bash.exec(
          "connector.providers.actions --provider-config-id gmail-provider",
        );
        expect(providerActions.exitCode).not.toBe(0);
        expect(providerActions.stderr).toContain("connector.providers.read");
        assert(gateway.control.discoveryReads === 0);
        const connect = await bash.exec("connector.connect --service gmail --connection-name work");
        expect(connect.exitCode).not.toBe(0);
        expect(connect.stderr).toContain("connector.connections.create");
        const action = await bash.exec(
          "connector.actions.execute --account-id arbitrary --action-id gmail.search_threads --input-json '{}'",
        );
        expect(action.exitCode).not.toBe(0);
        expect(action.stderr).toContain("connector.actions.execute");
        expect(gateway.links).toEqual([]);
        expect(gateway.executions).toEqual([]);
        assert(gateway.control.requestReads === 0);
      }),
    ],
  }));
});

test("missing project credentials return an actionable configuration error without initializing a provider connection", async () => {
  await runProjectConnectorScenario((gateway) => ({
    name: "Connector missing project configuration",
    env: { OOMOL_PROJECT_API_KEY: undefined },
    setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
    steps: ({ then }) => [
      then.assert("the scope is available but not falsely authenticated", async (ctx) => {
        await expect(
          ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: "check missing connector key",
            code: 'async () => await context.user("user-1").connector.check()',
          }),
        ).rejects.toThrow("Connector is not configured.");
        await expect(
          ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: "discover providers with a missing connector key",
            code: 'async () => await context.user("user-1").connector.listProviderConfigs()',
          }),
        ).rejects.toThrow("Connector is not configured.");
        await expect(
          ctx.runCodemode({
            scope: { kind: "org", orgId: "org-1" },
            label: "discover provider actions with a missing connector key",
            code: 'async () => await context.user("user-1").connector.listProviderActions({ providerConfigId: "gmail-provider" })',
          }),
        ).rejects.toThrow("Connector is not configured.");
        assert(gateway.control.discoveryReads === 0);
        expect(gateway.links).toEqual([]);
        assert(gateway.control.requestReads === 0);
      }),
    ],
  }));
});
