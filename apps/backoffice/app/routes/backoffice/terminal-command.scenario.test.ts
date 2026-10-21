import { assert, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  type BackofficeScenarioContext,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { behindBackofficeLayout } from "@/layouts/backoffice-layout.test-support";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryOtpObject } from "../../../workers/otp.do";
import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import type { DashboardCommandResult, DashboardPathAutocompleteResult } from "./dashboard-terminal";
import { action as terminalCommandAction } from "./terminal-command";

const runTerminalAction = behindBackofficeLayout(terminalCommandAction);

const scenarioObjects = {
  MCP: null,
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

/** Posts the terminal form for the organization, as the terminal's fetcher does. */
async function postTerminal(ctx: BackofficeScenarioContext, fields: Record<string, string>) {
  const url = new URL("https://backoffice.example/backoffice/terminal/org/ops-team");
  const request = new Request(url, {
    method: "POST",
    headers: { cookie: ctx.vars.cookie as string },
    body: new URLSearchParams(fields),
  });
  return runTerminalAction({
    request,
    url,
    pattern: "/backoffice/terminal/:scopeKind/:scopeId",
    params: { scopeKind: "org", scopeId: "ops-team" },
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  });
}

test("a command continued over lines with a trailing backslash runs as one, and completes paths past the break", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Multi-line terminal commands",
      setup: ({ given }) => [
        given.organization.exists({ id: "org-ops", slug: "ops-team", name: "Ops team" }),
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({
          email: "operator@example.test",
          captureSessionCookieAs: "sessionCookie",
        }),
        then.assert("sign the operator in to the organization", async (ctx) => {
          const auth = ctx.runtime.objects.auth.singleton();
          const session = await auth.http.fetch(
            new Request("https://backoffice.example/api/auth/get-session", {
              headers: { cookie: ctx.vars.sessionCookie as string },
            }),
          );
          assert(session.ok);
          const { user } = (await session.json()) as { user: { id: string } };
          await auth.commands.applyScenarioFixture({
            members: [{ organizationId: "org-ops", userId: user.id, roles: ["owner"] }],
          });
          const exchange = await auth.http.fetch(
            new Request("https://backoffice.example/api/auth/backoffice-token", {
              method: "POST",
              headers: {
                cookie: ctx.vars.sessionCookie as string,
                origin: "https://backoffice.example",
                "content-type": "application/json",
              },
              body: JSON.stringify({ selection: "required", organizationId: "org-ops" }),
            }),
          );
          assert(exchange.ok, await exchange.clone().text());
          ctx.vars.cookie = exchange.headers
            .getSetCookie()
            .map((header) => header.split(";", 1)[0])
            .join("; ");
        }),
        then.assert("the continued command runs once and moves the directory", async (ctx) => {
          const result = (await postTerminal(ctx, {
            intent: "run-command",
            cwd: "/",
            command:
              "mkdir -p /workspace/reports \\\n  && cd /workspace/reports \\\n  && echo ready",
          })) as DashboardCommandResult;
          assert.isTrue(result.ok, result.output);
          assert.equal(result.output.trim(), "ready");
          assert.equal(result.nextCwd, "/workspace/reports");
        }),
        then.assert("a path after a line break completes like any other argument", async (ctx) => {
          const commandLine = "ls\\\n  /workspace/rep";
          const result = (await postTerminal(ctx, {
            intent: "autocomplete-path",
            cwd: "/",
            commandLine,
            cursorPosition: String(commandLine.length),
          })) as DashboardPathAutocompleteResult;
          assert.isTrue(result.ok, result.error);
          assert.equal(result.parentPath, "/workspace/");
          assert.deepEqual(
            result.entries.map((entry) => entry.path),
            ["/workspace/reports"],
          );
        }),
      ],
    }),
  );
});
