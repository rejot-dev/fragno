import { assert, expect, test, vi } from "vitest";

import {
  createAppActionVerifier,
  type VerifiedAppActionRequest,
} from "@fragno-dev/backoffice-api/v0/app-actions";
import type { PiAgentConfig, PiManagerAgentDirectory } from "@fragno-dev/backoffice-api/v0/pi";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  openNodeSqliteDatabase,
  openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import { PostHog } from "posthog-node";

import type { Context, Message } from "@earendil-works/pi-ai";
import {
  defineExtension,
  hook,
  ToolTask,
  type ConversationView,
  type HarnessSettings,
  type InboxState,
} from "@earendil-works/pi-durable";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeServiceExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { createInstalledAppExecution } from "@/fragno/app-installations/authority";
import { issueBackofficeTokenResultSchema } from "@/fragno/auth/contracts";
import type { CodemodeWorkflowParams } from "@/fragno/automation/engine/codemode-invocation";
import { createRouteBackedAutomationRouterRuntime } from "@/fragno/automation/routing-route-runtime";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import { piAgentActor } from "@/fragno/pi/agent/pi-agent-actor";
import { piAgentObjectName } from "@/fragno/pi/agent/pi-agent-contract";
import { PI_NOTIFICATION_ENTRY_KIND } from "@/fragno/pi/agent/pi-agent-notification-entry";
import { createPiPostHogExtension } from "@/fragno/pi/extensions/posthog/posthog-extension";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { BackofficePostHogContext, captureBackofficeServerException } from "@/posthog.server";
import { fetchPiManagerAgent, submitPiManagerPrompt } from "@/routes/backoffice/agents/data";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { AppInstallationsObject } from "./app-installations-object";
import { shutdownCloudflarePostHog } from "./lib/cloudflare-posthog";
import { createScriptedPiAgentDependencies } from "./pi-durable-scenario.test-support";
import { PiObject } from "./pi-object";

const scenarioObjects = allLocalObjects;

const PI_SCENARIO_AVAILABLE_MODELS = [
  {
    provider: "faux",
    modelId: "faux-1",
    label: "Faux 1",
    contextWindow: 128_000,
    thinkingLevels: ["off"],
  },
] as const;

/** Every agent object gets its own copy of the scripted responses. */
function scriptedAgents(
  responses: FauxResponseStep[],
  settings?: HarnessSettings,
): LocalBackofficeObjects {
  return {
    PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
      const faux = fauxProvider();
      faux.setResponses(responses);
      const models = createModels();
      models.setProvider(faux.provider);
      return new PiObject({
        state,
        runtime,
        dependencies: {
          ...createScriptedPiAgentDependencies(models),
          ...(settings ? { settings } : {}),
        },
        openStorage: openPiSessionStore,
        idFromConfig: piAgentIdFromConfig,
        nowEpochMs,
      });
    },
  };
}

async function request(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
  route: string,
  body: unknown,
  method: "GET" | "POST" | "PUT" = body === null ? "GET" : "POST",
) {
  return await runtime.objects.piManager.for(execution.scope).http.fetchAuthorized(
    new Request(`https://pi-manager.test/api/pi-manager${route}`, {
      method,
      headers: body === null ? {} : { "content-type": "application/json" },
      body: body === null ? undefined : JSON.stringify(body),
    }),
    { execution, propagationContext: null },
  );
}

async function prompt(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
  input: {
    agentName?: string;
    requestId?: string;
    content?: string;
  } = {},
) {
  const {
    agentName = "assistant",
    requestId = "backoffice-prompt",
    content = "Use the Backoffice context.",
  } = input;
  const submitted = await request(runtime, execution, `/agents/${agentName}/prompts`, {
    requestId,
    content,
  });
  assert.equal(submitted.status, 202, await submitted.clone().text());
}

async function view(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
  agentName = "assistant",
) {
  const response = await request(runtime, execution, `/agents/${agentName}/view`, null);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json<ConversationView>();
}

async function submission(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
  requestId: string,
  agentName = "assistant",
) {
  return await (
    await request(runtime, execution, `/agents/${agentName}/prompts/${requestId}`, null)
  ).json<{ status: string } | { code: string }>();
}

function lastUserText(context: Context) {
  const content = context.messages.filter((message) => message.role === "user").at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

function userTexts(view: ConversationView) {
  return view.entries.filter((entry) => entry.kind === "pi.user");
}

function toolResults(context: Context) {
  return context.messages.filter(
    (message): message is Extract<Message, { role: "toolResult" }> => message.role === "toolResult",
  );
}

test("durable Pi runs a workspace agent with its instructions, scoped skills, Backoffice tools, and other agents", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "durable-tool-scenario" },
  });
  // One dispatcher serves the researcher's turn and the assistant agent prompted from codemode.
  const respond: FauxResponseStep = (context) => {
    const system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
    const lastUser = lastUserText(context);
    expect(system).toContain("Workspace instructions from `/workspace/AGENTS.md`");
    expect(system).toContain("Follow the shared workspace guidance.");
    if (lastUser === "First other-agent prompt") {
      return fauxAssistantMessage("First other-agent answer.");
    }
    if (lastUser === "Second other-agent prompt") {
      return fauxAssistantMessage("Second other-agent answer.");
    }
    const results = toolResults(context);
    if (results.length === 0) {
      expect(system).toContain("Keep the researcher instruction.");
      expect(system).toContain(
        "You are the Backoffice agent `researcher`: that is your `agentName` in `pi.agent.*` tools",
      );
      expect(system.match(/# Backoffice System Guidance/g)).toHaveLength(1);
      expect(system).toContain("Scoped durable skill");
      expect(system).toContain("/workspace/skills/durable/SKILL.md");
      expect(system).toContain("/static/skills/");
      expect(system).toContain("/static/codemode/");
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: `async () => {
          await state.writeFile({ path: "/workspace/durable-result.txt", content: "executed through Backoffice" });
          const first = await pi.submitPrompt({ agentName: "assistant", content: "First other-agent prompt" });
          const second = await context.current.pi.submitPrompt({ agentName: "assistant", content: "Second other-agent prompt" });
          const directory = await pi.listAgents({});
          const assistant = await pi.getAgent({ agentName: "assistant" });
          return {
            first: first.status,
            second: second.status,
            agents: directory.agents.map(agent => agent.agentName),
            assistant: assistant.agentName,
          };
        }`,
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    expect(results).toHaveLength(1);
    assert(
      results.every((result) => !result.isError),
      JSON.stringify(results),
    );
    expect(results.find((result) => result.toolName === "codemode")?.details).toMatchObject({
      result: {
        first: "queued",
        second: "queued",
        agents: ["assistant", "researcher"],
        assistant: "assistant",
      },
    });
    return fauxAssistantMessage("Backoffice tool run finished.");
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi Backoffice environment and tools",
      options: { drain: false },
      objects: { ...scenarioObjects, ...scriptedAgents([respond, respond, respond, respond]) },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/AGENTS.md",
          content: "Follow the shared workspace guidance.",
        }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/skills/durable/SKILL.md",
          content:
            "---\nname: scoped-durable\ndescription: Scoped durable skill\n---\nRead the scoped notes before acting.",
        }),
      ],
      steps: ({ then }) => [
        then.assert("run and settle a real Backoffice agent turn", async ({ runtime }) => {
          const defined = await request(runtime, execution, "/agents", {
            agentName: "researcher",
            description: "Researches the workspace.",
            model: null,
            permissions: ["*"],
            instructions: "Keep the researcher instruction.",
          });
          assert.equal(defined.status, 201, await defined.clone().text());
          await prompt(runtime, execution, { agentName: "researcher" });
          await runtime.drain();
          const transcript = await view(runtime, execution, "researcher");
          expect(JSON.stringify(transcript.entries)).toContain("Backoffice tool run finished.");
          const assistant = await view(runtime, execution, "assistant");
          expect(userTexts(assistant)).toHaveLength(2);
          expect(JSON.stringify(assistant.entries)).toContain("First other-agent answer.");
          expect(JSON.stringify(assistant.entries)).toContain("Second other-agent answer.");
          const directory = await (
            await request(runtime, execution, "/agents", null)
          ).json<PiManagerAgentDirectory>();
          expect(directory.agents.map((agent) => [agent.agentName, agent.provisioned])).toEqual([
            ["assistant", true],
            ["researcher", true],
          ]);
        }),
        then.files.contains({
          orgId: "org-1",
          path: "/workspace/durable-result.txt",
          text: "executed through Backoffice",
        }),
      ],
    }),
  );
});

test("durable Pi refreshes workspace guidance between turns without leaking another scope's instructions", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "workspace-guidance-scenario" },
  });
  const observedPrompts: string[] = [];
  const respond: FauxResponseStep = (context) => {
    observedPrompts.push(getCurrentSystemPrompt(context.messages));
    return fauxAssistantMessage("Workspace guidance checked.");
  };
  const revisions = [null, "Prefer short answers.", "Prefer detailed answers.", "", null];
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi workspace guidance lifecycle",
      options: { drain: false },
      objects: { ...scenarioObjects, ...scriptedAgents(revisions.map(() => respond)) },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.organization.exists({ id: "org-2" }),
        given.codemode.writeFile({
          orgId: "org-2",
          path: "/workspace/AGENTS.md",
          content: "Private instructions for another organization.",
        }),
      ],
      steps: ({ then }) =>
        revisions.map((instructions, index) =>
          then.assert(`prompt with workspace guidance revision ${index}`, async ({ runtime }) => {
            const context = createRouteBackedRuntimeContext({
              emitter: { kind: "caller" },
              runtime: runtime.services,
              kernel: new BackofficeKernel(runtime.services),
              execution,
            });
            assert(context.stateBackend);
            if (instructions === null) {
              await context.stateBackend.rm("/workspace/AGENTS.md", { force: true });
            } else {
              await context.stateBackend.writeFile("/workspace/AGENTS.md", instructions);
            }
            await prompt(runtime, execution, { requestId: `workspace-guidance-${index}` });
            await runtime.drain();
            expect(observedPrompts).toHaveLength(index + 1);
            const system = observedPrompts[index];
            expect(system).toContain("# Backoffice System Guidance");
            expect(system).not.toContain("Private instructions for another organization.");
            if (instructions) {
              expect(system).toContain("Workspace instructions from `/workspace/AGENTS.md`");
              expect(system).toContain(instructions);
            } else {
              expect(system).not.toContain("Workspace instructions from `/workspace/AGENTS.md`");
            }
            for (const previous of revisions.slice(0, index)) {
              if (previous && previous !== instructions) {
                expect(system).not.toContain(previous);
              }
            }
            expect(
              await submission(runtime, execution, `workspace-guidance-${index}`),
            ).toMatchObject({
              status: "completed",
            });
          }),
        ),
    }),
  );
});

test("agents and users read another agent's messages and export its conversation", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "agent-messages-scenario" },
  });
  let research: unknown = null;
  const respond: FauxResponseStep = (context) => {
    const results = toolResults(context);
    if (lastUserText(context) === "What do the notes say?") {
      return results.length === 0
        ? fauxAssistantMessage(
            [
              fauxThinking("The notes are in the workspace."),
              fauxText("Checking the notes."),
              fauxToolCall("codemode", {
                code: `async () => await state.readFile({ path: "/workspace/notes.txt" })`,
              }),
            ],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage("The notes say: Durable marker.");
    }
    if (results.length === 0) {
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: `async () => {
          const latest = await pi.listMessages({ agentName: "assistant", last: 1 });
          const earlier = await pi.listMessages({ agentName: "assistant", before: latest.before });
          const exported = await pi.exportConversation({ agentName: "assistant", out: "/workspace/assistant.jsonl" });
          return { latest, earlier, exported };
        }`,
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    research = results[0]?.details;
    return fauxAssistantMessage("Read the assistant's conversation.");
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi agent messages and export",
      options: { drain: false },
      objects: { ...scenarioObjects, ...scriptedAgents([respond, respond]) },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/notes.txt",
          content: "Durable marker",
        }),
      ],
      steps: ({ then }) => [
        then.assert("an agent reads only what was said, newest last", async ({ runtime }) => {
          await prompt(runtime, execution, { content: "What do the notes say?" });
          await runtime.drain();
          const defined = await request(runtime, execution, "/agents", {
            agentName: "researcher",
            description: "Reads other agents.",
            model: null,
            permissions: ["pi.read", "upload.modify"],
            instructions: "",
          });
          assert.equal(defined.status, 201, await defined.clone().text());
          await prompt(runtime, execution, {
            agentName: "researcher",
            requestId: "research",
            content: "Read the assistant.",
          });
          await runtime.drain();

          const said = (page: { messages: { role: string; text: string }[] }) =>
            page.messages.map(({ role, text }) => [role, text]);
          const { result } = research as {
            result: {
              latest: { messages: { role: string; text: string }[]; before: number | null };
              earlier: { messages: { role: string; text: string }[]; before: number | null };
              exported: { path: string; entryCount: number };
            };
          };
          expect(said(result.latest)).toEqual([["assistant", "The notes say: Durable marker."]]);
          assert(result.latest.before !== null, "earlier messages exist");
          expect(said(result.earlier)).toEqual([
            ["user", "What do the notes say?"],
            ["assistant", "Checking the notes."],
          ]);
          expect(result.earlier.before).toBeNull();
          assert(result.exported.path === "/workspace/assistant.jsonl");
        }),
        then.assert("a user prints the last message and reads the export", async ({ runtime }) => {
          const context = createRouteBackedRuntimeContext({
            emitter: { kind: "caller" },
            runtime: runtime.services,
            kernel: new BackofficeKernel(runtime.services),
            execution,
          });
          assert(context.stateBackend);
          const { bash } = await createInteractiveBashHost({
            context: { ...context, stateBackend: context.stateBackend },
          });
          const printed = await bash.exec("pi.agent.messages --agent assistant --last 1");
          assert.equal(printed.exitCode, 0, printed.stderr);
          expect(printed.stdout).toMatch(
            /^\(earlier messages: --before \d+\)\n\n\[assistant · \S+\]\nThe notes say: Durable marker\.\n$/u,
          );

          const prompted = await bash.exec(
            "pi.prompt.get --agent researcher --request-id research --format json",
          );
          assert.equal(prompted.exitCode, 0, prompted.stderr);
          expect(JSON.parse(prompted.stdout)).toEqual({
            requestId: "research",
            status: "completed",
            answer: "Read the assistant's conversation.",
          });
          const neverSent = await bash.exec(
            "pi.prompt.get --agent researcher --request-id never-sent --format json",
          );
          assert.equal(neverSent.exitCode, 0, neverSent.stderr);
          expect(JSON.parse(neverSent.stdout)).toBeNull();

          const misspelled = await bash.exec("pi.agent.messages --agent asistant --last 1");
          assert(misspelled.exitCode === 1);
          expect(misspelled.stderr).toContain("No agent in this scope is named 'asistant'");
          const readOnly = await bash.exec(
            "pi.agent.export --agent assistant --output /static/assistant.jsonl",
          );
          assert(readOnly.exitCode === 1);
          expect(readOnly.stderr).toContain("under /workspace");

          const exported = await bash.exec("cat /workspace/assistant.jsonl");
          assert.equal(exported.exitCode, 0, exported.stderr);
          const [header, ...entries] = exported.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { type: string; entry: { id: number } });
          expect(header).toMatchObject({ type: "pi-durable-agent", version: 3 });
          const ids = entries.map(({ entry }) => entry.id);
          expect(ids).toEqual([...ids].sort((a, b) => a - b));
          const lines = JSON.stringify(entries);
          expect(lines).toContain("The notes are in the workspace.");
          expect(lines).toContain('"toolName":"codemode"');
          expect(lines.indexOf("What do the notes say?")).toBeLessThan(
            lines.indexOf("The notes say: Durable marker."),
          );
        }),
      ],
    }),
  );
});

test("messages and exports start at the newest compaction or clear, as the chat does, unlike answers", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "agent-context-reach-scenario" },
  });
  async function bashIn(runtime: InMemoryBackofficeRuntime) {
    const context = createRouteBackedRuntimeContext({
      emitter: { kind: "caller" },
      runtime: runtime.services,
      kernel: new BackofficeKernel(runtime.services),
      execution,
    });
    assert(context.stateBackend);
    const { bash } = await createInteractiveBashHost({
      context: { ...context, stateBackend: context.stateBackend },
    });
    return bash;
  }
  async function said(runtime: InMemoryBackofficeRuntime) {
    const printed = await (
      await bashIn(runtime)
    ).exec("pi.agent.messages --agent assistant --format json");
    assert.equal(printed.exitCode, 0, printed.stderr);
    const page = JSON.parse(printed.stdout) as {
      messages: { role: string; text: string }[];
      before: number | null;
    };
    return { said: page.messages.map(({ role, text }) => [role, text]), before: page.before };
  }
  async function exported(runtime: InMemoryBackofficeRuntime, options = "") {
    const bash = await bashIn(runtime);
    const written = await bash.exec(
      `pi.agent.export --agent assistant --output /workspace/assistant.jsonl ${options}`,
    );
    assert.equal(written.exitCode, 0, written.stderr);
    const file = await bash.exec("cat /workspace/assistant.jsonl");
    const [header, ...entries] = file.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { entry: { kind: string } });
    return { header, kinds: entries.map(({ entry }) => entry.kind), text: JSON.stringify(entries) };
  }
  async function promptStatus(runtime: InMemoryBackofficeRuntime, requestId: string) {
    const printed = await (
      await bashIn(runtime)
    ).exec(`pi.prompt.get --agent assistant --request-id ${requestId} --format json`);
    assert.equal(printed.exitCode, 0, printed.stderr);
    return JSON.parse(printed.stdout) as unknown;
  }
  async function ask(runtime: InMemoryBackofficeRuntime, requestId: string, content: string) {
    await prompt(runtime, execution, { requestId, content });
    await runtime.drain();
  }
  const { PI: createAgent } = scriptedAgents(
    [
      fauxAssistantMessage("First answer."),
      fauxAssistantMessage("Second answer."),
      fauxAssistantMessage("Both answers were given."),
      fauxAssistantMessage("Third answer."),
      fauxAssistantMessage("Fourth answer."),
    ],
    { compaction: { keepRecentTokens: 1 } },
  );
  assert(createAgent);
  let assistantObject: PiObject | null = null;

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi messages and export from the active context",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        // The scenario's only agent object, to read an export as it streams.
        PI: (input) => {
          assistantObject = createAgent(input) as PiObject;
          return assistantObject;
        },
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("a compaction's summary stands where it was made", async ({ runtime }) => {
          await ask(runtime, "first", "First question?");
          await ask(runtime, "second", "Second question?");
          const compacted = await request(runtime, execution, "/agents/assistant/compact", {
            instructions: "Keep the answers.",
          });
          assert.equal(compacted.status, 202, await compacted.clone().text());
          await runtime.drain();
          await ask(runtime, "third", "Third question?");

          // Pi keeps the newest answer verbatim, before the summary that replaced the rest.
          expect(await said(runtime)).toEqual({
            said: [
              ["assistant", "Second answer."],
              ["compaction", "Both answers were given."],
              ["user", "Third question?"],
              ["assistant", "Third answer."],
            ],
            before: null,
          });
          const active = await exported(runtime);
          expect(active.header).toMatchObject({ version: 3, history: false });
          expect(active.kinds.slice(0, 2)).toEqual(["pi.assistant", "pi.compaction"]);
          expect(active.text).not.toContain("First question?");
        }),
        then.assert(
          "a clear hides what came before it, but not its answers",
          async ({ runtime }) => {
            // An export already under way when the clear lands keeps the context it started in.
            assert(assistantObject);
            const reader = (
              await assistantObject.exportEntries(
                { scope: execution.scope, agentName: "assistant" },
                false,
              )
            ).getReader();
            const chunks = [(await reader.read()).value];

            const reset = await request(runtime, execution, "/agents/assistant/reset", {});
            assert.equal(reset.status, 204, await reset.clone().text());
            await runtime.drain();
            await ask(runtime, "fourth", "Fourth question?");

            for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
              chunks.push(chunk.value);
            }
            const decoder = new TextDecoder();
            const started = chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("");
            expect(started).toContain("Third answer.");
            expect(started).not.toContain("Fourth question?");
            expect(started).not.toContain('"kind":"pi.reset"');

            expect(await said(runtime)).toEqual({
              said: [
                ["user", "Fourth question?"],
                ["assistant", "Fourth answer."],
              ],
              before: null,
            });
            // A prompt's answer is read by its request ID, wherever the context now starts.
            expect(await promptStatus(runtime, "first")).toEqual({
              requestId: "first",
              status: "completed",
              answer: "First answer.",
            });

            const active = await exported(runtime);
            assert(active.kinds[0] === "pi.reset");
            expect(active.text).not.toContain("Third question?");
            const whole = await exported(runtime, "--history");
            expect(whole.header).toMatchObject({ version: 3, history: true });
            expect(whole.text).toContain("First question?");
            expect(whole.text).toContain("Fourth answer.");
          },
        ),
      ],
    }),
  );
});

test("an agent's backfill records agent events as the agent's turn, keeping its delegation", async () => {
  const scope: BackofficeContextScope = { kind: "org", orgId: "org-1", jurisdiction: null };
  const execution = createBackofficeServiceExecution({
    scope,
    service: { type: "automation", id: "backfill-scenario" },
  });
  const respond: FauxResponseStep = (context) =>
    toolResults(context).length === 0
      ? fauxAssistantMessage(
          [fauxToolCall("codemode", { code: "async () => await pi.backfillAgentEvents({})" })],
          { stopReason: "toolUse" },
        )
      : fauxAssistantMessage("Backfilled.");
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Pi agent events backfilled by an agent",
      options: { drain: false },
      objects: { ...scenarioObjects, ...scriptedAgents([respond, respond]) },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert(
          "automations the backfilled event starts stay within the agent's delegation",
          async ({ runtime }) => {
            const automations = runtime.objects.automations.for(scope).commands;
            // An agent the events record but the manager never defined, so the backfill deletes it.
            await automations.ingestEvent({
              id: "stale:ghost",
              scope,
              scopeRestriction: null,
              source: "pi",
              eventType: "agent.created",
              occurredAt: new Date(runtime.now()).toISOString(),
              payload: {
                definition: {
                  agentName: "ghost",
                  description: "Gone already.",
                  model: null,
                  permissions: ["*"],
                  instructions: "",
                },
              },
              actors: execution.actors,
              subject: {
                scope: { kind: "org", orgId: "org-1", jurisdiction: null },
                agentName: "ghost",
              },
              causation: { kind: "origin" },
            });
            await prompt(runtime, execution, {});
            await runtime.drain();

            const { events } = await automations.listEventsOfType({
              source: "pi",
              eventType: "agent.deleted",
              cursor: null,
            });
            expect(events).toEqual([
              expect.objectContaining({
                id: "pi-agent-backfill:ghost:stale:ghost",
                scopeRestriction: null,
                actors: {
                  ...execution.actors,
                  delegation: [...execution.actors.delegation, piAgentActor(scope, "assistant")],
                },
              }),
            ]);
          },
        ),
      ],
    }),
  );
});

test("durable Pi lists Marketplace-installed skills and finds them by any keyword", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "durable-search-scenario" },
  });
  const skillPath = "/workspace/slack-setup/skills/slack-setup/SKILL.md";
  const objectOverrides = scriptedAgents([
    (context) => {
      expect(
        JSON.stringify(context.messages.filter((message) => message.role === "system")),
      ).toContain(skillPath);
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: `async () => {
          const lines = (page) =>
            [...page.upload.results, ...page.static.results].flatMap(({ path, matches }) =>
              matches.map((match) => path + ":" + match.line + ": " + match.lineText),
            );
          const found = await state.searchFiles({
            pattern: "/workspace/**",
            keywords: ["Slack integration", "createConnection"],
          });
          const missing = await state.searchFiles({ pattern: "**", keywords: ["no-such-keyword"] });
          return { found: lines(found), hasMore: found.upload.hasMore, missing: lines(missing) };
        }`,
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const result = toolResults(context).at(-1);
      assert.equal(result?.isError, false, JSON.stringify(result));
      expect(result?.details).toMatchObject({
        result: {
          found: [
            `${skillPath}:6: Connect the Slack integration with a bot token.`,
            `${skillPath}:7: await api.createConnection({ slug: "slack" });`,
          ],
          hasMore: false,
          missing: [],
        },
      });
      return fauxAssistantMessage("Search finished.");
    },
  ]);
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi skill discovery and keyword search",
      options: { drain: false },
      objects: { ...scenarioObjects, ...objectOverrides },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        // Sorted before the skill, this file floods the first keyword's index term without ever
        // matching the keyword, which used to end the first page empty.
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/a-noise.md",
          content: "integration\n".repeat(80),
        }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: skillPath,
          content: [
            "---",
            "name: slack-setup",
            "description: Set up Slack bot messages and Events API webhooks.",
            "---",
            "# Slack setup",
            "Connect the Slack integration with a bot token.",
            'await api.createConnection({ slug: "slack" });',
          ].join("\n"),
        }),
      ],
      steps: ({ then }) => [
        then.assert("the agent finds the installed skill", async ({ runtime }) => {
          await prompt(runtime, execution);
          await runtime.drain();
          const transcript = await view(runtime, execution);
          expect(JSON.stringify(transcript.entries)).toContain("Search finished.");
        }),
      ],
    }),
  );
});

test("codemode output past the harness limits keeps its beginning and end and saves the rest for the agent", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "codemode-output-scenario" },
  });
  let fullOutputPath = "";
  const objectOverrides = scriptedAgents([
    fauxAssistantMessage(
      [
        fauxToolCall("codemode", {
          code: `async () => {
            for (let i = 0; i < 500; i++) console.log("line " + i + " " + "x".repeat(190));
            return "result-marker";
          }`,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const result = toolResults(context).at(-1);
      assert(result);
      const text = result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      const details = result.details as { fullOutputPath: string };
      expect(details.fullOutputPath).toMatch(/^\/workspace\/\.pi\/assistant\/outputs\/.+\.txt$/);
      expect(details).not.toHaveProperty("result");
      expect(details).not.toHaveProperty("logs");
      expect(text).toContain("line 0 ");
      expect(text).not.toContain("line 250 ");
      expect(text.trimEnd().split("\n").slice(-3, -2)).toEqual(["result-marker"]);
      expect(text).toContain(`Full output: ${details.fullOutputPath}.`);
      fullOutputPath = details.fullOutputPath;
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: `async () => {
              const lines = (await state.readFile({ path: ${JSON.stringify(fullOutputPath)} })).split("\\n");
              return lines.filter((line) => line.startsWith("line 250 ")).length + " " + lines.at(-1);
            }`,
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const result = toolResults(context).at(-1);
      assert.equal(result?.isError, false, JSON.stringify(result));
      expect(result?.details).toMatchObject({ result: "1 result-marker", fullOutputPath: null });
      return fauxAssistantMessage("Read the full output.");
    },
  ]);
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi codemode output overflow",
      options: { drain: false },
      objects: { ...scenarioObjects, ...objectOverrides },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("the agent reads the saved output back", async ({ runtime }) => {
          await prompt(runtime, execution);
          await runtime.drain();
          const transcript = await view(runtime, execution);
          expect(JSON.stringify(transcript.entries)).toContain("Read the full output.");
          expect(fullOutputPath).not.toBe("");
        }),
      ],
    }),
  );
});

test("an agent's definition narrows every turn and an edited definition applies from the next turn", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "narrowing-scenario" },
  });
  const reader = {
    description: "Reads the workspace.",
    model: null,
    permissions: ["upload.read"],
    instructions: "",
  };
  const storeWrite = fauxAssistantMessage(
    [
      fauxToolCall("codemode", {
        code: `async () => await store.set({ key: "reader/result", value: "written" })`,
      }),
    ],
    { stopReason: "toolUse" },
  );
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi definition narrowing",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        ...scriptedAgents([
          storeWrite,
          (context) => {
            const result = toolResults(context).at(-1);
            assert.equal(result?.isError, true, JSON.stringify(result));
            expect(JSON.stringify(result)).toContain(
              "Agent 'reader' is not granted store.modify; its definition grants: upload.read.",
            );
            return fauxAssistantMessage("The reader may not write the store.");
          },
          storeWrite,
          (context) => {
            const result = toolResults(context).at(-1);
            assert.equal(result?.isError, false, JSON.stringify(result));
            return fauxAssistantMessage("The widened reader wrote the store.");
          },
        ]),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert(
          "an unrestricted principal is narrowed to the definition",
          async ({ runtime }) => {
            const defined = await request(runtime, execution, "/agents", {
              agentName: "reader",
              ...reader,
            });
            assert.equal(defined.status, 201, await defined.clone().text());
            await prompt(runtime, execution, { agentName: "reader", requestId: "narrowed" });
            await runtime.drain();
            expect(await submission(runtime, execution, "narrowed", "reader")).toMatchObject({
              status: "completed",
            });
          },
        ),
        then.store.missing({ orgId: "org-1", key: "reader/result" }),
        then.assert("the edited definition governs the next turn", async ({ runtime }) => {
          const widened = await request(
            runtime,
            execution,
            "/agents/reader",
            { ...reader, description: "Reads and writes.", permissions: ["*"] },
            "PUT",
          );
          assert.equal(widened.status, 200, await widened.clone().text());
          await prompt(runtime, execution, { agentName: "reader", requestId: "widened" });
          await runtime.drain();
          expect(JSON.stringify((await view(runtime, execution, "reader")).entries)).toContain(
            "The widened reader wrote the store.",
          );
        }),
        then.store.entry({ orgId: "org-1", key: "reader/result", value: "written" }),
      ],
    }),
  );
});

test("an agent waits in its turn for the subagents it starts, also those waiting for a slot", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "subagent-join" },
  });
  const documents = ["doc-1", "doc-2", "doc-3", "doc-4", "doc-5"];
  let heard: unknown = null;
  let refused: { isError: boolean; text: string } | null = null;
  let nested = "";
  // Subagents answer only once the agent waits for them, so one still waits for a slot then.
  let joined!: () => void;
  const joining = new Promise<void>((resolve) => (joined = resolve));
  // One dispatcher serves the agent's turn and its subagents.
  const respond: FauxResponseStep = async (context) => {
    const task = lastUserText(context);
    const results = toolResults(context);
    if (task === "Check every document.") {
      if (results.length === 0) {
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: `async () => {
                for (const requestId of ${JSON.stringify(documents)}) {
                  await pi.submitPrompt({ agentName: "assistant", requestId, subagent: true, content: "Check " + requestId + "." });
                }
              }`,
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      if (results.length === 1) {
        joined();
        return fauxAssistantMessage(
          [fauxToolCall("awaitSubagents", { requestIds: [...documents, "doc-unknown"] })],
          { stopReason: "toolUse" },
        );
      }
      const [text] = results[1]!.content.flatMap((block) =>
        block.type === "text" ? [block.text] : [],
      );
      heard = JSON.parse(text!);
      return fauxAssistantMessage("Every document is checked.");
    }
    // A subagent cannot wait for subagents: four doing so would hold every slot.
    if (task === "Check doc-1." && results.length === 0) {
      return fauxAssistantMessage([fauxToolCall("awaitSubagents", { requestIds: ["doc-2"] })], {
        stopReason: "toolUse",
      });
    }
    // Nor start subagents, or ask to hear how prompts end, from code.
    if (task === "Check doc-2." && results.length === 0) {
      return fauxAssistantMessage(
        [
          fauxToolCall("codemode", {
            code: `async () => {
              const refusals = [];
              for (const input of [
                { subagent: true },
                { agentName: "assistant", notifyWhenDone: true },
              ]) {
                try {
                  await pi.submitPrompt({ agentName: "assistant", content: "Go deeper.", ...input });
                  refusals.push("accepted");
                } catch (error) {
                  refusals.push(String(error.message));
                }
              }
              return refusals;
            }`,
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    if (task === "Check doc-2.") {
      nested = results[0]!.content.flatMap((block) =>
        block.type === "text" ? [block.text] : [],
      )[0]!;
    }
    if (task === "Check doc-1.") {
      const [result] = results;
      refused = {
        isError: result!.isError,
        text: result!.content.flatMap((block) => (block.type === "text" ? [block.text] : []))[0]!,
      };
    }
    await joining;
    return fauxAssistantMessage(`${task.replace("Check ", "").replace(".", "")} is fine.`);
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi joins subagents",
      options: { drain: false },
      objects: { ...scenarioObjects, ...scriptedAgents(Array.from({ length: 12 }, () => respond)) },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("the agent starts five subagents and waits for them", async ({ runtime }) => {
          await prompt(runtime, execution, {
            requestId: "check",
            content: "Check every document.",
          });
          await runtime.drain();
          expect(await submission(runtime, execution, "check")).toMatchObject({
            status: "completed",
          });
        }),
        then.assert("it hears each answer in the order it asked, in the same turn", () => {
          expect(heard).toEqual([
            { requestId: "doc-1", status: "answered", answer: "doc-1 is fine." },
            { requestId: "doc-2", status: "answered", answer: "doc-2 is fine." },
            { requestId: "doc-3", status: "answered", answer: "doc-3 is fine." },
            { requestId: "doc-4", status: "answered", answer: "doc-4 is fine." },
            // It still waited for a slot when the agent started waiting for it.
            { requestId: "doc-5", status: "answered", answer: "doc-5 is fine." },
            { requestId: "doc-unknown", status: "notFound" },
          ]);
        }),
        then.assert("subagents run without the tool", () => {
          expect(refused).toMatchObject({ isError: true });
          expect(refused?.text).toContain("awaitSubagents");
        }),
        then.assert("subagents start no subagents and ask for no replies", () => {
          expect(nested).toContain("A subagent cannot start subagents");
          expect(nested).toContain("A subagent cannot be notified when a prompt ends");
          expect(nested).not.toContain("accepted");
        }),
        then.assert("the agent's conversation holds only its own turn", async ({ runtime }) => {
          const transcript = await view(runtime, execution);
          expect(userTexts(transcript)).toHaveLength(1);
          expect(JSON.stringify(transcript.entries)).toContain("Every document is checked.");
        }),
        then.assert("its page lists them under the tool call that asked", async ({ runtime }) => {
          const transcript = await view(runtime, execution);
          const [codemodeCall] = transcript.entries.flatMap((entry) =>
            (entry.model ?? []).flatMap((message) =>
              message.role === "assistant"
                ? message.content.flatMap((block) =>
                    block.type === "toolCall" && block.name === "codemode" ? [block.id] : [],
                  )
                : [],
            ),
          );
          const listed = await (
            await request(runtime, execution, "/agents/assistant/subagents", null)
          ).json<{ subagents: { requestId: string; askedBy: unknown }[] }>();
          expect(listed.subagents.map(({ requestId, askedBy }) => [requestId, askedBy])).toEqual(
            [...documents]
              .reverse()
              .map((requestId) => [requestId, { kind: "turn", toolCallId: codemodeCall }]),
          );
        }),
      ],
    }),
  );
});

test("reports of subagents that end together are handled in one turn", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "subagent-reports" },
  });
  const heard: string[][] = [];
  // The turn handling the first report works on until the second waits to join it.
  let reported!: () => void;
  const reports = new Promise<void>((resolve) => (reported = resolve));
  const respond: FauxResponseStep = async (context) => {
    const task = lastUserText(context);
    if (task.startsWith("Write a haiku about ")) {
      return fauxAssistantMessage(`A haiku about ${task.slice("Write a haiku about ".length)}`);
    }
    if (task === "Ask for two haikus.") {
      return toolResults(context).length === 0
        ? fauxAssistantMessage(
            [
              fauxToolCall("codemode", {
                code: `async () => {
                  for (const season of ["spring", "summer"]) {
                    await pi.submitPrompt({ agentName: "assistant", requestId: season, subagent: true, notifyWhenDone: true, content: "Write a haiku about " + season + "." });
                  }
                }`,
              }),
            ],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage("Asked; they report back.");
    }
    heard.push(heardEvents(context).map(({ subject }) => String(subject.requestId)));
    if (heard.length === 1) {
      await reports;
      return fauxAssistantMessage([fauxToolCall("codemode", { code: "async () => null" })], {
        stopReason: "toolUse",
      });
    }
    return fauxAssistantMessage("Both haikus are in.");
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi handles subagent reports together",
      options: { drain: false },
      objects: { ...scenarioObjects, ...scriptedAgents(Array.from({ length: 8 }, () => respond)) },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("the second report joins the turn the first started", async ({ runtime }) => {
          await prompt(runtime, execution, { requestId: "ask", content: "Ask for two haikus." });
          const running = runtime.drain();
          await vi.waitFor(
            async () => {
              const inbox = (await view(runtime, execution)).docs["pi.inbox"] as InboxState;
              expect(inbox.items.map(({ mode }) => mode)).toEqual(["steer"]);
            },
            { timeout: 5_000, interval: 20 },
          );
          reported();
          await running;
          expect(heard.map((events) => events.sort())).toEqual([
            [expect.any(String)],
            ["spring", "summer"],
          ]);
        }),
        then.assert("each report shows once, and no turn handles it again", async ({ runtime }) => {
          const transcript = await view(runtime, execution);
          const kinds = transcript.entries.map(({ kind }) => kind);
          expect(kinds.filter((kind) => kind === PI_NOTIFICATION_ENTRY_KIND)).toHaveLength(2);
          // The prompt, and the request the first report's turn handles.
          expect(userTexts(transcript)).toHaveLength(2);
          expect(JSON.stringify(transcript.entries)).toContain("Both haikus are in.");
        }),
      ],
    }),
  );
});

test("subagents an app starts each answer one task in a conversation of their own", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "subagent-prompts" },
  });
  // What each conversation's first request saw, by its prompt, and the sessions they ran in.
  const seen = new Map<string, string[]>();
  const instructed = new Map<string, string>();
  const sessions = new Set<string>();
  const respond: FauxResponseStep = (context, options) => {
    const task = lastUserText(context);
    const results = toolResults(context);
    if (results.length === 0) {
      seen.set(
        task,
        context.messages
          .filter((message) => message.role === "user")
          .map(({ content }) => (typeof content === "string" ? content : JSON.stringify(content))),
      );
      const system = JSON.stringify(
        context.messages.filter((message) => message.role === "system"),
      );
      instructed.set(task, system.includes("Answer as a subagent.") ? "subagent" : "agent");
      sessions.add(options?.sessionId ?? "none");
    }
    if (task === "Write the store.") {
      return results.length === 0
        ? fauxAssistantMessage(
            [
              fauxToolCall("codemode", {
                code: `async () => await store.set({ key: "reader/result", value: "written" })`,
              }),
            ],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage(
            JSON.stringify(results).includes("Agent 'reader' is not granted store.modify")
              ? "I may not write the store."
              : "I wrote the store.",
          );
    }
    return fauxAssistantMessage(task === "Read document 2." ? "Document 2 read." : "Hello.");
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi subagents started by prompts",
      options: { drain: false },
      objects: { ...scenarioObjects, ...scriptedAgents(Array.from({ length: 6 }, () => respond)) },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("the agent and two subagents answer", async ({ runtime }) => {
          const reader = {
            description: "Reads documents.",
            model: null,
            permissions: ["upload.read"],
            instructions: "Answer as the reader.",
          };
          const defined = await request(runtime, execution, "/agents", {
            agentName: "reader",
            ...reader,
          });
          assert.equal(defined.status, 201, await defined.clone().text());
          const own = await request(runtime, execution, "/agents/reader/prompts", {
            requestId: "own",
            content: "Talk to me.",
          });
          assert.equal(own.status, 202, await own.clone().text());
          // Subagents admitted after this run under the edited definition; the agent's turn not.
          const edited = await request(
            runtime,
            execution,
            "/agents/reader",
            { ...reader, instructions: "Answer as a subagent." },
            "PUT",
          );
          assert.equal(edited.status, 200, await edited.clone().text());
          for (const [requestId, content, subagent] of [
            ["doc-1", "Write the store.", true],
            ["doc-2", "Read document 2.", true],
          ] as const) {
            const submitted = await request(runtime, execution, "/agents/reader/prompts", {
              requestId,
              content,
              subagent,
            });
            assert.equal(submitted.status, 202, await submitted.clone().text());
          }
          await runtime.drain();
          for (const requestId of ["own", "doc-1", "doc-2"]) {
            expect(await submission(runtime, execution, requestId, "reader")).toMatchObject({
              status: "completed",
            });
          }
        }),
        then.assert("each conversation sees only its own prompt, under its own turn", () => {
          expect(Object.fromEntries(instructed)).toEqual({
            "Talk to me.": "agent",
            "Write the store.": "subagent",
            "Read document 2.": "subagent",
          });
          expect(Object.fromEntries(seen)).toEqual({
            "Talk to me.": ["Talk to me."],
            "Write the store.": ["Write the store."],
            "Read document 2.": ["Read document 2."],
          });
          assert(sessions.size === 3);
          assert(!sessions.has("none"));
        }),
        then.assert("the agent's conversation holds only its own turn", async ({ runtime }) => {
          const transcript = await view(runtime, execution, "reader");
          expect(userTexts(transcript)).toHaveLength(1);
          expect(JSON.stringify(transcript.entries)).not.toContain("Document 2 read.");
        }),
        then.assert("the agent lists its subagents, newest first", async ({ runtime }) => {
          const listed = await request(runtime, execution, "/agents/reader/subagents", null);
          expect(await listed.json()).toEqual({
            subagents: [
              {
                requestId: "doc-2",
                task: "Read document 2.",
                askedAt: expect.any(String),
                askedBy: { kind: "person" },
                status: { requestId: "doc-2", status: "completed", answer: "Document 2 read." },
                startedAt: expect.any(String),
                answeredAt: expect.any(String),
              },
              {
                requestId: "doc-1",
                task: "Write the store.",
                askedAt: expect.any(String),
                askedBy: { kind: "person" },
                status: {
                  requestId: "doc-1",
                  status: "completed",
                  answer: "I may not write the store.",
                },
                startedAt: expect.any(String),
                answeredAt: expect.any(String),
              },
            ],
          });
        }),
        then.assert("a subagent's conversation reads by its request ID", async ({ runtime }) => {
          const subagentView = await request(
            runtime,
            execution,
            "/agents/reader/subagents/doc-1/view",
            null,
          );
          assert.equal(subagentView.status, 200, await subagentView.clone().text());
          expect(JSON.stringify(await subagentView.json())).toContain("I may not write the store.");
          const missing = await request(
            runtime,
            execution,
            "/agents/reader/subagents/own/view",
            null,
          );
          assert(missing.status === 404);
          const messages = await request(
            runtime,
            execution,
            "/agents/reader/messages?last=1&subagent=doc-2",
            null,
          );
          expect(await messages.json()).toMatchObject({
            messages: [{ role: "assistant", text: "Document 2 read." }],
          });
        }),
        // A subagent runs as whoever started it, narrowed by the agent's definition.
        then.store.missing({ orgId: "org-1", key: "reader/result" }),
      ],
    }),
  );
});

test("stopping an agent aborts its running subagents and its turn waiting for them", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "subagent-stop" },
  });
  // The agent starts a subagent and waits for it; the subagent answers only once it is stopped.
  const respond: FauxResponseStep = async (context, options) => {
    const results = toolResults(context);
    if (lastUserText(context) === "Delegate and wait.") {
      return fauxAssistantMessage(
        [
          results.length === 0
            ? fauxToolCall("codemode", {
                code: `async () => await pi.submitPrompt({ agentName: "assistant", requestId: "doc-1", subagent: true, content: "Wait for the stop." })`,
              })
            : fauxToolCall("awaitSubagents", { requestIds: ["doc-1"] }),
        ],
        { stopReason: "toolUse" },
      );
    }
    await new Promise<void>((resolve) => {
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage([], { stopReason: "aborted" });
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi subagents stopped",
      options: { drain: false },
      objects: { ...scenarioObjects, ...scriptedAgents(Array.from({ length: 4 }, () => respond)) },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("the stop ends the subagent and the wait", async ({ runtime }) => {
          await prompt(runtime, execution, { requestId: "lead", content: "Delegate and wait." });
          const running = runtime.drainAlarms();
          await vi.waitFor(
            async () => {
              expect(await submission(runtime, execution, "doc-1")).toMatchObject({
                status: "running",
              });
              // The agent's turn waits in the tool.
              const live = (await view(runtime, execution)).docs["pi.live"];
              expect(JSON.stringify(live)).toContain('"name":"awaitSubagents"');
            },
            { timeout: 5_000, interval: 20 },
          );
          const stopped = await request(runtime, execution, "/agents/assistant/stop", {});
          assert.equal(stopped.status, 204, await stopped.clone().text());
          await running;
          await runtime.drain();
          for (const requestId of ["lead", "doc-1"]) {
            expect(await submission(runtime, execution, requestId)).toMatchObject({
              status: "failed",
              reason: "aborted",
            });
          }
        }),
      ],
    }),
  );
});

for (const revocation of ["restricted", "disabled", "deleted"] as const) {
  test(`durable Pi runs each turn as its own prompter after a linked-user route is ${revocation}`, async () => {
    const scope = { kind: "org", orgId: "org-1", jurisdiction: null } as const;
    const execution = createBackofficeUserExecution({ scope, userId: "member" });
    const workflowPath = "/workspace/automations/delegated-pi.workflow.js";
    let modelCalls = 0;
    const telegramEvent = (id: string) => ({
      id,
      scopeRestriction: null,
      scope,
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-10-04T16:23:00.000Z",
      payload: { chatId: "1001", messageId: id, fromUserId: "1001", text: "Hello" },
      actors: {
        initiator: {
          scope: "external" as const,
          source: "telegram",
          type: "chat",
          id: "1001",
          role: "initiator" as const,
        },
        principal: null,
        delegation: [],
      },
      subject: { scope: { kind: "org" as const, orgId: "org-1", jurisdiction: null } },
      causation: { kind: "origin" as const },
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: `durable Pi turn authority after the route is ${revocation}`,
        // The restricted route's later workflow fails because it may no longer prompt the agent.
        options: { drain: false, allowErroredWorkflows: revocation === "restricted" },
        objects: {
          ...scenarioObjects,
          ...scriptedAgents([
            (context) => {
              modelCalls += 1;
              expect(JSON.stringify(context.messages)).toContain("# Backoffice System Guidance");
              return fauxAssistantMessage(
                [
                  fauxToolCall("codemode", {
                    code: `async () => await store.set({ key: "linked-pi/result", value: "written" })`,
                  }),
                ],
                { stopReason: "toolUse" },
              );
            },
            (context) => {
              modelCalls += 1;
              const result = toolResults(context).at(-1);
              expect(result?.isError, JSON.stringify(result)).toBe(false);
              return fauxAssistantMessage("The linked-user turn answered.");
            },
            () => {
              modelCalls += 1;
              return fauxAssistantMessage("The member's own turn answered.");
            },
          ]),
        },
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        setup: ({ given }) => [
          given.auth.user({ id: "owner", role: "admin" }),
          given.auth.user({ id: "member", role: "user" }),
          given.auth.organization({ id: "org-1", ownerUserId: "owner", ownerRoles: ["owner"] }),
          given.auth.member({ orgId: "org-1", userId: "member", roles: ["member"] }),
          given.identity.binding({ orgId: "org-1", externalId: "1001", userId: "member" }),
          given.direct.file({
            orgId: "org-1",
            path: workflowPath,
            content: `export default defineWorkflow({ name: "delegated-pi" }, async (event, step) => {
              return await step.do("prompt linked-user turn", async () => await pi.submitPrompt({
                agentName: "assistant",
                requestId: event.instanceId + ":prompt",
                content: "Answer on behalf of the linked user.",
              }));
            });`,
          }),
          given.router.route({
            orgId: "org-1",
            id: "telegram-pi-linking",
            name: "Linked-user Pi",
            enabled: true,
            priority: 100,
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              matcher: { path: "$.payload.chatId", op: "eq", value: "1001" },
            },
            action: {
              kind: "start_workflow",
              authority: { kind: "linked-user", grants: "inherit" },
              workflowScriptPath: workflowPath,
              instanceIdTemplate: "linked-pi-${event.id}",
            },
          }),
        ],
        steps: ({ when, then, runner }) => [
          when.automation.ingestEvent(telegramEvent("linked-pi-message")),
          then.assert("the route's turn runs as the linked user", async ({ runtime }) => {
            await runtime.drain();
            const transcript = await view(runtime, execution);
            expect(JSON.stringify(transcript.entries)).toContain("The linked-user turn answered.");
            expect(modelCalls).toBe(2);
          }),
          then.store.entry({ orgId: "org-1", key: "linked-pi/result", value: "written" }),
          then.kernel.action({
            operation: BACKOFFICE_PERMISSION.store.modify,
            scope,
            actors: {
              initiator: telegramEvent("linked-pi-message").actors.initiator,
              principal: { scope: "internal", type: "user", id: "member", role: "principal" },
              delegation: [
                {
                  scope: "internal",
                  type: "automation",
                  id: "automation-route:telegram-pi-linking",
                  role: "delegate",
                },
                piAgentActor(scope, "assistant"),
              ],
            },
          }),
          runner.restartObject({ binding: "AUTOMATIONS", scope }),
          then.assert("revoke the owning route's current authority", async ({ runtime }) => {
            const router = createRouteBackedAutomationRouterRuntime({
              object: runtime.objects.automations.for(scope),
              execution: createBackofficeUserExecution({ scope, userId: "owner" }),
            });
            if (revocation === "deleted") {
              assert(await router.deleteRoute({ id: "telegram-pi-linking" }));
            } else {
              await router.updateRoute({
                id: "telegram-pi-linking",
                ...(revocation === "disabled"
                  ? { enabled: false }
                  : {
                      action: {
                        kind: "start_workflow",
                        authority: {
                          kind: "linked-user",
                          grants: [BACKOFFICE_PERMISSION.pi.read],
                        },
                        workflowScriptPath: workflowPath,
                        instanceIdTemplate: "linked-pi-${event.id}",
                      },
                    }),
              });
            }
          }),
          then.assert(
            "the member's own prompt runs without the route's authority",
            async ({ runtime }) => {
              await prompt(runtime, execution, { requestId: "member-prompt" });
              await runtime.drain();
              expect(await submission(runtime, execution, "member-prompt")).toMatchObject({
                status: "completed",
              });
              expect(JSON.stringify((await view(runtime, execution)).entries)).toContain(
                "The member's own turn answered.",
              );
              expect(modelCalls).toBe(3);
            },
          ),
          ...(revocation === "restricted"
            ? [
                when.automation.ingestEvent(telegramEvent("restricted-pi-message")),
                then.assert(
                  "a later route turn has only the route's current grants",
                  async ({ runtime }) => {
                    await runtime.drain();
                    // Without pi.modify the route cannot even admit a turn.
                    expect(
                      await submission(
                        runtime,
                        execution,
                        "linked-pi-restricted-pi-message:prompt",
                      ),
                    ).toMatchObject({ code: "PROMPT_NOT_FOUND" });
                    const workflow = createRouteBackedAutomationWorkflowRuntime({
                      object: runtime.objects.automations.for(scope),
                      execution: createBackofficeUserExecution({ scope, userId: "owner" }),
                    });
                    assert(
                      (
                        await workflow.getInstance({
                          instanceId: "linked-pi-restricted-pi-message",
                        })
                      ).details.status === "errored",
                    );
                    expect(userTexts(await view(runtime, execution))).toHaveLength(2);
                    expect(modelCalls).toBe(3);
                  },
                ),
              ]
            : []),
        ],
      }),
    );
  });
}

test("durable Pi delivers committed model usage to its owning organization", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "durable-billing-scenario" },
  });
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi committed usage billing",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        ...scriptedAgents(
          [
            fauxAssistantMessage("Usage was durably billed."),
            fauxAssistantMessage("Compaction usage was durably billed."),
          ],
          { compaction: { keepRecentTokens: 1 } },
        ),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("bill the cumulative committed model usage once", async ({ runtime }) => {
          await prompt(runtime, execution);
          await runtime.drain();

          const period = new Date(runtime.now()).toISOString().slice(0, 7);
          const trackers = await runtime.objects.billing
            .for({ kind: "org", orgId: "org-1", jurisdiction: null })
            .commands.getTrackers({
              scope: execution.scope,
              period,
              pageSize: 100,
            });
          const totalTokens = trackers.trackers.find(
            (tracker) => tracker.meter === "ai.tokens.total",
          );
          expect(Number(totalTokens?.quantity)).toBeGreaterThan(0);
          assert(totalTokens?.eventCount === "1");

          const compacted = await request(runtime, execution, "/agents/assistant/compact", {
            instructions: "Preserve the billed answer.",
          });
          assert.equal(compacted.status, 202, await compacted.clone().text());
          await runtime.drain();
          const afterCompaction = await runtime.objects.billing
            .for({ kind: "org", orgId: "org-1", jurisdiction: null })
            .commands.getTrackers({ scope: execution.scope, period, pageSize: 100 });
          const compactedTotalTokens = afterCompaction.trackers.find(
            (tracker) => tracker.meter === "ai.tokens.total",
          );
          expect(Number(compactedTotalTokens?.quantity)).toBeGreaterThan(
            Number(totalTokens?.quantity),
          );
          assert(compactedTotalTokens?.eventCount === "2");

          await runtime.drain();
          const afterDuplicateDrain = await runtime.objects.billing
            .for({ kind: "org", orgId: "org-1", jurisdiction: null })
            .commands.getTrackers({ scope: execution.scope, period, pageSize: 100 });
          expect(
            afterDuplicateDrain.trackers.find((tracker) => tracker.meter === "ai.tokens.total"),
          ).toEqual(compactedTotalTokens);
        }),
      ],
    }),
  );
});

test("personal agents run without an organization and keep their usage after leaving one", async () => {
  const scope = { kind: "user", userId: "member", jurisdiction: null } as const;
  const execution = createBackofficeUserExecution({ scope, userId: "member" });
  let modelCalls = 0;
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "personal usage follows ownership",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        ...scriptedAgents(
          Array.from({ length: 3 }, () => () => {
            modelCalls += 1;
            return fauxAssistantMessage("Personal work.");
          }),
        ),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [
        given.auth.user({ id: "owner", role: "admin" }),
        given.auth.user({ id: "member", role: "user" }),
        given.auth.organization({ id: "org-1", ownerUserId: "owner", ownerRoles: ["owner"] }),
      ],
      steps: ({ when, then }) => [
        then.assert("a user without memberships starts their own agent", async ({ runtime }) => {
          await prompt(runtime, execution, { requestId: "personal" });
          await runtime.drain();
          expect(await submission(runtime, execution, "personal")).toMatchObject({
            status: "completed",
          });
          expect(modelCalls).toBe(1);
          await runtime.objects.auth.singleton().commands.addAdminOrganizationMember({
            organizationId: "org-1",
            userEmail: "member@scenario.test",
            roles: ["member"],
          });
        }),
        then.assert(
          "joining an organization does not redirect personal usage",
          async ({ runtime }) => {
            await prompt(runtime, execution, { requestId: "joined" });
            await runtime.drain();
            expect(await submission(runtime, execution, "joined")).toMatchObject({
              status: "completed",
            });
          },
        ),
        when.auth.removeMember({ orgId: "org-1", userId: "member" }),
        then.assert(
          "leaving does not block personal work or change its ledger",
          async ({ runtime }) => {
            await prompt(runtime, execution, { requestId: "left" });
            await runtime.drain();
            expect(await submission(runtime, execution, "left")).toMatchObject({
              status: "completed",
            });
            expect(modelCalls).toBe(3);
            const period = new Date(runtime.now()).toISOString().slice(0, 7);
            const personal = await runtime.objects.billing
              .for(scope)
              .commands.getStatement({ period });
            expect(personal.trackers).toContainEqual(
              expect.objectContaining({ meter: "ai.tokens.total", eventCount: "3" }),
            );
            expect(
              (
                await runtime.objects.billing
                  .for({ kind: "org", orgId: "org-1", jurisdiction: null })
                  .commands.getStatement({ period })
              ).trackers,
            ).toEqual([]);
            await runtime.drain();
            expect(
              await runtime.objects.billing.for(scope).commands.getStatement({ period }),
            ).toEqual(personal);
          },
        ),
      ],
    }),
  );
});

for (const leaveOrganization of [false, true]) {
  test(`durable Pi workflows retain personal usage attribution across nested workflows and restart${leaveOrganization ? " after leaving an organization" : ""}`, async () => {
    const scope = { kind: "user", userId: "member", jurisdiction: null } as const;
    const execution = createBackofficeUserExecution({ scope, userId: "member" });
    const promptOperation = "pi.submitPrompt";
    const savedWorkflowCode = `export default defineWorkflow({ name: "saved-sentence-checker" }, async (event, step) => {
      await step.waitForEvent("wait for sentence", { type: "sentence" });
      return await step.do("submit sentence", async () => await ${promptOperation}({
        agentName: "assistant",
        requestId: event.instanceId + ":sentence",
        content: "Classify this sentence",
      }));
    });`;
    const workflowCode = `defineWorkflow({ name: "inline-sentence-checker" }, async (event, step) => {
      await step.do("start nested workflow", async () => await context.current.workflow.createInstance({
        path: "/workspace/automations/saved-sentence-checker.workflow.js",
        instanceId: "saved-checker",
      }));
      await step.waitForEvent("wait for sentence", { type: "sentence" });
      return await step.do("submit sentence", async () => await ${promptOperation}({
        agentName: "assistant",
        requestId: event.instanceId + ":sentence",
        content: "Classify this sentence",
      }));
    });`;
    let inlineInstanceId: string;
    let tokensBeforeResume: { quantity: string; eventCount: string };
    let classifierCalls = 0;
    const respond: FauxResponseStep = (context) => {
      if (lastUserText(context) === "Classify this sentence") {
        classifierCalls += 1;
        return fauxAssistantMessage("Not naughty.");
      }
      const results = toolResults(context);
      if (results.length === 0) {
        return fauxAssistantMessage([fauxToolCall("codemode", { code: workflowCode })], {
          stopReason: "toolUse",
        });
      }
      expect(results).toHaveLength(1);
      expect(results[0]?.isError, JSON.stringify(results)).toBe(false);
      return fauxAssistantMessage("Sentence checker is waiting.");
    };
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: `personal workflow usage${leaveOrganization ? " after leaving an organization" : ""}`,
        files: backofficeFiles.workspaceStarter({
          "automations/saved-sentence-checker.workflow.js": savedWorkflowCode,
        }),
        options: { drain: false },
        // Beyond the classifications, the agent hears back when its workflow ends.
        objects: {
          ...scenarioObjects,
          ...scriptedAgents(Array.from({ length: 5 }, () => respond)),
        },
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        setup: ({ given }) => [
          given.auth.user({ id: "owner", role: "admin" }),
          given.auth.user({ id: "member", role: "user" }),
          given.auth.organization({ id: "org-1", ownerUserId: "owner", ownerRoles: ["owner"] }),
          given.auth.member({ orgId: "org-1", userId: "member", roles: ["member"] }),
        ],
        steps: ({ when, then, runner }) => [
          then.assert(
            "inline and nested workflows persist the execution scope and actors",
            async ({ runtime }) => {
              await prompt(runtime, execution, {});
              await runtime.drain();
              const workflow = createRouteBackedAutomationWorkflowRuntime({
                object: runtime.objects.automations.for(scope),
                execution,
              });
              const instances = await workflow.listInstances({ pageSize: 10 });
              expect(instances.instances, JSON.stringify(instances)).toHaveLength(2);
              const inline = instances.instances.find(
                (instance) => instance.id !== "saved-checker",
              );
              assert(inline);
              inlineInstanceId = inline.id;
              for (const instance of instances.instances) {
                assert.equal(instance.details.status, "waiting");
                const response = await runtime.objects.automations
                  .for(scope)
                  .http.fetchAuthorized(
                    new Request(
                      `https://automations.test/api/workflows/codemode-script/instances/${instance.id}`,
                    ),
                    { execution, propagationContext: null },
                  );
                assert.equal(response.status, 200, await response.clone().text());
                const stored = await response.json<{ meta: { params: CodemodeWorkflowParams } }>();
                expect(stored.meta.params.execution).toMatchObject({
                  scopeRestriction: null,
                  scope,
                  actors: {
                    ...execution.actors,
                    delegation: [...execution.actors.delegation, piAgentActor(scope, "assistant")],
                  },
                });
                expect(stored.meta.params.execution).not.toHaveProperty("userAuthority");
              }
              const period = new Date(runtime.now()).toISOString().slice(0, 7);
              const trackers = await runtime.objects.billing
                .for(scope)
                .commands.getTrackers({ scope, period, pageSize: 100 });
              const tokens = trackers.trackers.find(
                (tracker) => tracker.meter === "ai.tokens.total",
              );
              assert(tokens);
              tokensBeforeResume = { quantity: tokens.quantity, eventCount: tokens.eventCount };
            },
          ),
          runner.restartObject({ binding: "AUTOMATIONS", scope }),
          ...(leaveOrganization
            ? [when.auth.removeMember({ orgId: "org-1", userId: "member" })]
            : []),
          then.assert("resumed workflow turns retain personal attribution", async ({ runtime }) => {
            const workflow = createRouteBackedAutomationWorkflowRuntime({
              object: runtime.objects.automations.for(scope),
              execution,
            });
            for (const instanceId of [inlineInstanceId, "saved-checker"]) {
              await workflow.sendEvent({
                instanceId,
                type: "sentence",
                payload: { sentence: "hello" },
              });
            }
            await runtime.drain();
            for (const instanceId of [inlineInstanceId, "saved-checker"]) {
              // Personal work remains authorized after organization membership is removed.
              assert.equal((await workflow.getInstance({ instanceId })).details.status, "complete");
              expect(await submission(runtime, execution, `${instanceId}:sentence`)).toMatchObject({
                status: "completed",
              });
            }
            const transcript = JSON.stringify((await view(runtime, execution)).entries);
            expect(transcript).toContain("Not naughty.");
            expect(classifierCalls).toBe(2);
            const period = new Date(runtime.now()).toISOString().slice(0, 7);
            const trackers = await runtime.objects.billing
              .for(scope)
              .commands.getTrackers({ scope, period, pageSize: 100 });
            const tokens = trackers.trackers.find((tracker) => tracker.meter === "ai.tokens.total");
            assert(tokens);
            expect(Number(tokens.quantity)).toBeGreaterThan(Number(tokensBeforeResume.quantity));
            expect(Number(tokens.eventCount)).toBeGreaterThan(
              Number(tokensBeforeResume.eventCount),
            );
          }),
        ],
      }),
    );
  });
}

/** The events an agent was notified of, as the model reads them. */
function heardEvents(context: Context) {
  return context.messages.flatMap((message) => {
    if (message.role !== "user" || typeof message.content !== "string") {
      return [];
    }
    const match = /^<backoffice-event ([^>]*)>\n(.*)\n<\/backoffice-event>$/su.exec(
      message.content,
    );
    if (!match) {
      return [];
    }
    const data = JSON.parse(match[2]) as {
      subject: Record<string, unknown>;
      payload: Record<string, unknown>;
    };
    return [{ attributes: match[1], ...data }];
  });
}

test("an agent hears back from the workflow it starts when it ends", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "workflow-reply-scenario" },
  });
  const workflowCode = `defineWorkflow({ name: "approval-checker" }, async (event, step) => {
    const approval = await step.waitForEvent("wait for approval", { type: "approval" });
    return { approved: approval.payload.approved };
  });`;
  let instanceId = "";
  const heard: Array<ReturnType<typeof heardEvents>[number]> = [];
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi workflow replies",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        ...scriptedAgents([
          fauxAssistantMessage([fauxToolCall("codemode", { code: workflowCode })], {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("The approval checker is waiting for approval."),
          (context) => {
            const completed = heardEvents(context).at(-1);
            assert(completed);
            heard.push(completed);
            return fauxAssistantMessage("The approval checker approved.");
          },
        ]),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("the waiting workflow does not notify its agent", async ({ runtime }) => {
          await prompt(runtime, execution, { content: "Check the approval." });
          await runtime.drain();
          const workflow = createRouteBackedAutomationWorkflowRuntime({
            object: runtime.objects.automations.for({
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            }),
            execution,
          });
          const [instance] = (await workflow.listInstances({ pageSize: 10 })).instances;
          assert(instance);
          instanceId = instance.id;
          assert.equal(instance.details.status, "waiting");
          expect(heard).toEqual([]);
        }),
        then.assert("the agent reads the result once it is approved", async ({ runtime }) => {
          const workflow = createRouteBackedAutomationWorkflowRuntime({
            object: runtime.objects.automations.for({
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            }),
            execution,
          });
          await workflow.sendEvent({ instanceId, type: "approval", payload: { approved: true } });
          await runtime.drain();
          expect((await workflow.getInstance({ instanceId })).details).toMatchObject({
            status: "complete",
            output: { approved: true },
          });
          const transcript = JSON.stringify((await view(runtime, execution)).entries);
          expect(transcript).toContain("The approval checker approved.");
        }),
        then.assert("the notification names the workflow and carries no route", () => {
          expect(heard).toEqual([
            {
              attributes: expect.stringMatching(/source="workflows" type="instance.completed"/),
              subject: { scope: execution.scope, workflowName: "approval-checker", instanceId },
              payload: { status: "complete", output: { approved: true }, error: null },
            },
          ]);
          expect(heard[0]?.attributes).not.toContain("route=");
        }),
      ],
    }),
  );
});

test("durable Pi restores scoped tools and reports interrupted codemode without repeating its mutation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-codemode-recovery-"));
  const snapshot = path.join(directory, "interrupted.sqlite");
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "codemode-recovery" },
  });
  const config: PiAgentConfig = {
    scope: execution.scope,
    agentName: "assistant",
  };
  let source: {
    agent: PiObject;
    options: ConstructorParameters<typeof PiObject>[0];
  } | null = null;
  const objectOverrides: LocalBackofficeObjects = {
    PI: ({ state, runtime, piAgentIdFromConfig, nowEpochMs }) => {
      const database = openNodeSqliteDatabase(":memory:");
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: `async () => {
          const count = Number(await state.readFile({ path: "/workspace/codemode-effects.txt" })) + 1;
          await state.writeFile({ path: "/workspace/codemode-effects.txt", content: String(count) });
          return { count };
        }`,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Original process completed."),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const captureCrashPoint = defineExtension({
        name: "capture-codemode-crash-point",
        hooks: [
          hook(ToolTask, {
            afterTool: async (call) => {
              if (call.name === "codemode") {
                // Capture real committed intent after the external mutation, before result settlement.
                await (await database).run("VACUUM INTO ?", snapshot);
              }
            },
          }),
        ],
      });
      const options = {
        state,
        runtime,
        dependencies: {
          ...createScriptedPiAgentDependencies(models),
          extensions: () => [captureCrashPoint],
        },
        openStorage: async () => await SqliteStorage.open(await database),
        idFromConfig: piAgentIdFromConfig,
        nowEpochMs,
      };
      const agent = new PiObject(options);
      source = { agent, options };
      return agent;
    },
  };
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "durable Pi interrupted codemode recovery",
        options: { drain: false },
        objects: { ...scenarioObjects, ...objectOverrides },
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: "/workspace/codemode-effects.txt",
            content: "0",
          }),
        ],
        steps: ({ then }) => [
          then.assert(
            "restore the actual SQLite crash point with fresh runtime context",
            async ({ runtime }) => {
              await prompt(runtime, execution);
              await runtime.drain();
              expect(JSON.stringify((await view(runtime, execution)).entries)).toContain(
                "Original process completed.",
              );
              const captured = source;
              if (captured === null) {
                throw new Error("The scenario did not provision a Pi agent.");
              }
              await captured.agent.close();
              const faux = fauxProvider();
              faux.setResponses([
                (context) => {
                  const result = toolResults(context).at(-1);
                  assert.equal(result?.isError, true, JSON.stringify(result));
                  expect(JSON.stringify(result)).toContain(
                    "Tool codemode was interrupted and may have partially run",
                  );
                  return fauxAssistantMessage(
                    [
                      fauxToolCall("codemode", {
                        code: `async () => await state.readFile({ path: "/workspace/codemode-effects.txt" })`,
                      }),
                    ],
                    { stopReason: "toolUse" },
                  );
                },
                (context) => {
                  const result = toolResults(context).at(-1);
                  assert.equal(result?.isError, false, JSON.stringify(result));
                  expect(result?.content).toEqual([{ type: "text", text: "1" }]);
                  return fauxAssistantMessage("Recovered with exactly one mutation.");
                },
              ]);
              const models = createModels();
              models.setProvider(faux.provider);
              const restored = new PiObject({
                ...captured.options,
                dependencies: { ...captured.options.dependencies, models },
                openStorage: async () => await openNodeSqliteStorage(snapshot),
              });
              try {
                // The restored turn record is the only authority the recovered tools can use.
                await restored.alarm();
                const transcript = (await restored.getView(config, null)) as ConversationView;
                expect(JSON.stringify(transcript.entries)).toContain(
                  "Recovered with exactly one mutation.",
                );
                expect(transcript.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(
                  1,
                );
              } finally {
                await restored.close();
              }
            },
          ),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable Pi scoped codemode handles prompt the selected scope's agent", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "scope-scenario" },
  });
  const userScope: BackofficeContextScope = { kind: "user", userId: "org-1", jurisdiction: null };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi scoped agent",
      options: { drain: false },
      // Codemode reaches a user by ID only when Auth knows them.
      setup: ({ given }) => [given.auth.user({ id: "org-1" })],
      objects: {
        ...scenarioObjects,
        ...scriptedAgents([
          (context) => {
            if (lastUserText(context) === "Hello from the organization agent.") {
              return fauxAssistantMessage("The personal agent answered.");
            }
            return fauxAssistantMessage(
              [
                fauxToolCall("codemode", {
                  code: `async () => await context.user("org-1").pi.submitPrompt({
                    agentName: "assistant",
                    content: "Hello from the organization agent.",
                  })`,
                }),
              ],
              { stopReason: "toolUse" },
            );
          },
          (context) => {
            const result = toolResults(context).at(-1);
            assert(result?.role === "toolResult");
            expect(result.isError, JSON.stringify(result)).toBe(false);
            return fauxAssistantMessage("Prompted the user-scoped agent.");
          },
        ]),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      steps: ({ then }) => [
        then.assert("scope changes rebuild the manager runtime", async ({ runtime }) => {
          await prompt(runtime, execution);
          await runtime.drain();
          expect(JSON.stringify((await view(runtime, execution)).entries)).toContain(
            "Prompted the user-scoped agent.",
          );
          const other = { ...execution, scope: userScope };
          const personal = await (await request(runtime, other, "/agents/assistant", null)).json();
          expect(personal).toMatchObject({ provisioned: true });
          expect(JSON.stringify((await view(runtime, other)).entries)).toContain(
            "The personal agent answered.",
          );
          const period = new Date(runtime.now()).toISOString().slice(0, 7);
          const query = { scope: userScope, period, pageSize: 100 };
          const personalUsage = await runtime.objects.billing
            .for(userScope)
            .commands.getTrackers(query);
          expect(personalUsage.trackers).toEqual(
            expect.arrayContaining([expect.objectContaining({ meter: "ai.tokens.total" })]),
          );
          const organizationUsage = await runtime.objects.billing
            .for(execution.scope)
            .commands.getTrackers(query);
          expect(organizationUsage.trackers).toEqual([]);
        }),
      ],
    }),
  );
});

test("an agent an app's installation prompts calls the app's actions as the installation", async () => {
  const org = { kind: "org", orgId: "org-1", jurisdiction: null } as const;
  const endpointUrl = "https://ledger.example/backoffice/actions";
  const received: VerifiedAppActionRequest[] = [];
  let verify: ((request: Request) => Promise<VerifiedAppActionRequest>) | null = null;
  let appId = "";
  const asInstallation = () =>
    createInstalledAppExecution({
      scope: org,
      actor: { kind: "installation" },
      installation: {
        appId,
        activation: 1,
        externalAccount: { id: "ledger-org-7", label: "Acme Books" },
      },
    });
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi turns prompted by an app installation",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        APP_INSTALLATIONS: (options) =>
          new AppInstallationsObject({
            ...options,
            fetch: async (input, init) => {
              verify ??= createAppActionVerifier({
                backofficeOrigin: "https://backoffice.test",
                endpointUrl,
                fetch: async (jwksInput, jwksInit) =>
                  await options.runtime.objects.auth
                    .singleton()
                    .http.fetch(new Request(jwksInput, jwksInit)),
              });
              const verified = await verify(new Request(input, init));
              received.push(verified);
              return verified.request.type === "ping"
                ? Response.json({ ok: true })
                : Response.json({ count: 3 });
            },
          }),
        ...scriptedAgents([
          fauxAssistantMessage(
            [
              fauxToolCall("codemode", {
                code: `async () => await integrations.execute({ connectionId: "app#ledger", actionId: "invoices.count", input: {} })`,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          (context) => {
            const result = toolResults(context).at(-1);
            assert.equal(result?.isError, false, JSON.stringify(result));
            return fauxAssistantMessage("Counted the invoices.");
          },
        ]),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [
        given.auth.user({ id: "global-admin", role: "admin" }),
        given.auth.user({ id: "owner" }),
        given.auth.organization({ id: org.orgId, ownerUserId: "owner" }),
      ],
      steps: ({ then }) => [
        then.assert("the owner installs Ledger, which links the installation", async (ctx) => {
          const client = await ctx.runtime.objects.auth
            .singleton()
            .commands.createAdminOAuthClient({
              administratorUserId: "global-admin",
              name: "Ledger",
              redirectUris: ["https://ledger.example/callback"],
              scopes: ["openid", "backoffice"],
            });
          const permissions = [
            BACKOFFICE_PERMISSION.pi.manage,
            BACKOFFICE_PERMISSION.pi.modify,
            BACKOFFICE_PERMISSION.pi.read,
            BACKOFFICE_PERMISSION.integrations.execute,
          ];
          const registered = await ctx.runtime.objects.apps.singleton().commands.registerApp({
            actions: {
              kind: "endpoint",
              endpointUrl,
              changeApproval: "automatic",
              actions: [
                {
                  id: "invoices.count",
                  label: "Count invoices",
                  description: "Count the invoices.",
                  inputSchema: { type: "object" },
                  outputSchema: { type: "object" },
                },
              ],
            },
            trust: { kind: "third-party" },
            slug: "ledger",
            oauthClientId: client.clientId,
            requestedPermissions: permissions,
          });
          assert(registered.ok);
          appId = registered.value.appId;
          const installations = ctx.runtime.objects.appInstallations.for(org).commands;
          assert(
            (
              await installations.installApp({
                actionsRevision: 1,
                appId,
                grantedPermissions: permissions,
                installedByUserId: "owner",
                resourceScope: { kind: "owner" },
              })
            ).ok,
          );
          assert(
            (
              await installations.claimInstallation({
                appId,
                activation: 1,
                externalAccount: { id: "ledger-org-7", label: "Acme Books" },
              })
            ).ok,
          );
        }),
        then.assert(
          "Ledger defines an agent and prompts it, and the agent's call reaches Ledger as the installation",
          async ({ runtime }) => {
            const defined = await request(runtime, asInstallation(), "/agents", {
              agentName: "counter",
              description: "Counts invoices.",
              model: null,
              permissions: ["integrations.execute"],
              instructions: "",
            });
            assert.equal(defined.status, 201, await defined.clone().text());
            await prompt(runtime, asInstallation(), { agentName: "counter", requestId: "count" });
            await runtime.drain();
            expect(await submission(runtime, asInstallation(), "count", "counter")).toMatchObject({
              status: "completed",
            });
            expect(
              received
                .filter(({ request }) => request.type === "action")
                .map(({ claims }) => claims),
            ).toMatchObject([{ actor: { kind: "installation" }, scopeRestriction: org }]);
          },
        ),
      ],
    }),
  );
});

test("an agent hears back from same-named agents it prompts in two scopes and reads their answers", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "agent-reply-scenario" },
  });
  const orgScope = execution.scope;
  const userScope: BackofficeContextScope = { kind: "user", userId: "org-1", jurisdiction: null };
  let heard: Array<ReturnType<typeof heardEvents>[number]> = [];
  // Every agent object runs its own copy of this script: the planner and both assistants.
  const respond: FauxResponseStep = (context) => {
    const request = lastUserText(context);
    if (request.startsWith("Hello from the planner")) {
      return fauxAssistantMessage(
        `The ${request.includes("personal") ? "personal" : "organization"} assistant answered.`,
      );
    }
    const answered = context.messages.at(-1)?.role === "toolResult";
    if (request === "Ask both assistants.") {
      // Request IDs are unique only per conversation, so both prompts may use the same one.
      return answered
        ? fauxAssistantMessage("Waiting for both assistants.")
        : fauxAssistantMessage(
            [
              fauxToolCall("codemode", {
                code: `async () => [
                  await context.current.pi.submitPrompt({
                    agentName: "assistant",
                    content: "Hello from the planner (organization).",
                    requestId: "task-1",
                    notifyWhenDone: true,
                  }),
                  await context.user("org-1").pi.submitPrompt({
                    agentName: "assistant",
                    content: "Hello from the planner (personal).",
                    requestId: "task-1",
                    notifyWhenDone: true,
                  }),
                ]`,
              }),
            ],
            { stopReason: "toolUse" },
          );
    }
    if (answered) {
      const result = toolResults(context).at(-1);
      expect(result?.isError, JSON.stringify(result)).toBe(false);
      return fauxAssistantMessage(`Read: ${JSON.stringify(result?.details)}`);
    }
    heard = heardEvents(context);
    const reads = heard.map(({ subject }) => {
      const scope = subject.scope as BackofficeContextScope;
      const handle = scope.kind === "user" ? `context.user("org-1")` : "context.current";
      return `${handle}.pi.getPrompt({ agentName: "assistant", requestId: ${JSON.stringify(subject.requestId)} })`;
    });
    return fauxAssistantMessage(
      [
        fauxToolCall("codemode", {
          code: `async () => (await Promise.all([${reads.join(", ")}])).map((prompt) => prompt.answer)`,
        }),
      ],
      { stopReason: "toolUse" },
    );
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi agent replies across scopes",
      options: { drain: false },
      // Codemode reaches a user by ID only when Auth knows them.
      setup: ({ given }) => [given.auth.user({ id: "org-1" })],
      objects: { ...scenarioObjects, ...scriptedAgents(Array.from({ length: 8 }, () => respond)) },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      steps: ({ then }) => [
        then.assert("the planner reads both answers once notified", async ({ runtime }) => {
          const defined = await request(runtime, execution, "/agents", {
            agentName: "planner",
            description: "Delegates to the assistants.",
            model: null,
            permissions: ["*"],
            instructions: "",
          });
          assert.equal(defined.status, 201, await defined.clone().text());
          await prompt(runtime, execution, {
            agentName: "planner",
            content: "Ask both assistants.",
          });
          await runtime.drain();
          const transcript = JSON.stringify((await view(runtime, execution, "planner")).entries);
          expect(transcript).toContain("The organization assistant answered.");
          expect(transcript).toContain("The personal assistant answered.");
        }),
        then.assert("each notification is one prompted turn's completion", () => {
          // The two managers reply independently, so either may arrive first.
          expect(heard).toHaveLength(2);
          expect(heard).toEqual(
            expect.arrayContaining(
              [orgScope, userScope].map((scope) => ({
                attributes: expect.stringMatching(
                  /^id="[^"]+" source="pi" type="turn.completed" /u,
                ),
                subject: { scope, agentName: "assistant", requestId: "task-1" },
                payload: { answerEntryId: expect.any(Number) },
              })),
            ),
          );
        }),
      ],
    }),
  );
});

test("an agent hears back from the saved workflow it starts in another scope", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1", jurisdiction: null },
    service: { type: "automation", id: "saved-workflow-reply-scenario" },
  });
  const heard: Array<ReturnType<typeof heardEvents>[number]> = [];
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi saved workflow replies across scopes",
      options: { drain: false },
      // Codemode reaches a user by ID only when Auth knows them.
      setup: ({ given }) => [given.auth.user({ id: "org-1" })],
      objects: {
        ...scenarioObjects,
        ...scriptedAgents([
          fauxAssistantMessage(
            [
              fauxToolCall("codemode", {
                code: `async () => {
                  const personal = context.user("org-1");
                  const path = "/workspace/automations/greeter.workflow.js";
                  await personal.state.writeFile({
                    path,
                    content: 'export default defineWorkflow({ name: "greeter" }, async (event) => ({ greeting: "Hello, " + event.payload.name }));',
                  });
                  return await personal.workflow.createInstance({
                    path,
                    instanceId: "greet-1",
                    payload: { name: "Ada" },
                    notifyWhenDone: true,
                  });
                }`,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          (context) => {
            const result = toolResults(context).at(-1);
            expect(result?.isError, JSON.stringify(result)).toBe(false);
            return fauxAssistantMessage("The greeter is running.");
          },
          (context) => {
            const completed = heardEvents(context).at(-1);
            assert(completed);
            heard.push(completed);
            return fauxAssistantMessage("The greeter finished.");
          },
        ]),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      steps: ({ then }) => [
        then.assert("the agent hears the run end in its own conversation", async ({ runtime }) => {
          await prompt(runtime, execution, { content: "Greet Ada in my personal scope." });
          await runtime.drain();
          expect(JSON.stringify((await view(runtime, execution)).entries)).toContain(
            "The greeter finished.",
          );
        }),
        then.assert("the notification carries the run's output", () => {
          expect(heard).toEqual([
            {
              attributes: expect.stringMatching(/source="workflows" type="instance.completed"/u),
              // The run is in the personal scope, where the agent follows up on it.
              subject: {
                scope: { kind: "user", userId: "org-1", jurisdiction: null },
                workflowName: "greeter",
                instanceId: "greet-1",
              },
              payload: { status: "complete", output: { greeting: "Hello, Ada" }, error: null },
            },
          ]);
        }),
      ],
    }),
  );
});

test("Cloudflare backend analytics delivers verified outcomes and Pi usage without conversation content", async () => {
  type IngestedEvent = {
    event: string;
    distinct_id: string;
    uuid: string;
    properties: Record<string, unknown>;
  };
  const received: IngestedEvent[] = [];
  let receiverStatus = 200;
  const receiver = createServer((incoming, response) => {
    incoming.setEncoding("utf8");
    let body = "";
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      // This local endpoint receives the real SDK's authoritative batch wire format.
      const batch = JSON.parse(body) as { batch: IngestedEvent[] };
      if (receiverStatus === 200) {
        received.push(...batch.batch);
      }
      response.writeHead(receiverStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: receiverStatus === 200 ? 1 : 0 }));
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address();
  assert(address !== null && typeof address !== "string");
  const client = new PostHog("phc_scenario", {
    host: `http://127.0.0.1:${address.port}`,
    flushAt: 100,
    flushInterval: 0,
    disableCompression: true,
    disableGeoip: true,
    fetchRetryCount: 0,
    requestTimeout: 1_000,
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-posthog-"));
  const deliveries: Promise<unknown>[] = [];
  const objectOverrides: LocalBackofficeObjects = {
    PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage("PRIVATE_ASSISTANT_OUTPUT"),
        fauxAssistantMessage("PRIVATE_SECOND_OUTPUT"),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      return new PiObject({
        state,
        runtime,
        dependencies: {
          ...createScriptedPiAgentDependencies(models),
          extensions: (agentConfig, agent) => [
            createPiPostHogExtension({
              config: agentConfig,
              agent,
              auth: runtime.objects.auth.singleton().commands,
              capture: async (event) => {
                client.capture(event);
              },
            }),
          ],
        },
        openStorage: openPiSessionStore,
        idFromConfig: piAgentIdFromConfig,
        nowEpochMs,
      });
    },
  };

  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "PostHog captures SQLite-backed server outcomes and durable generations",
        options: { drain: false, sqliteDataDirectory: directory },
        objects: { ...scenarioObjects, ...objectOverrides },
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_ACCESS_CODES_REQUIRED: "false" },
        vars: () => ({ session: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "analytics@example.test", captureSessionCookieAs: "session" }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.session,
            name: "Analytics",
            slug: "analytics",
          }),
          then.assert(
            "only successful operations reach the real ingestion endpoint",
            async (ctx) => {
              const origin = "https://backoffice.example";
              const exchange = await ctx.runtime.objects.auth.singleton().http.fetch(
                new Request(`${origin}/api/auth/backoffice-token`, {
                  method: "POST",
                  headers: { cookie: ctx.vars.session, origin, "content-type": "application/json" },
                  body: JSON.stringify({ selection: "preferred" }),
                }),
              );
              assert(exchange.ok, await exchange.clone().text());
              const { organization } = issueBackofficeTokenResultSchema.parse(
                await exchange.json(),
              );
              assert(organization);
              const scope = { kind: "org" as const, orgId: organization.id, jurisdiction: null };
              const cookie = exchange.headers
                .getSetCookie()
                .map((value) => value.split(";", 1)[0])
                .join("; ");
              const authenticatedRequest = new Request(`${origin}/backoffice/agents`, {
                method: "POST",
                headers: { cookie },
              });
              const context = createBackofficeRouterContextProvider(authenticatedRequest, {
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                env: ctx.runtime.env as unknown as CloudflareEnv,
                ctx: {} as ExecutionContext,
              });
              context.set(BackofficePostHogContext, {
                client,
                requestId: "request-scenario",
                userId: null,
                route: null,
                scope: null,
                capturedErrors: new WeakSet<Error>(),
                waitUntil: (promise) => {
                  deliveries.push(promise);
                },
              });
              const admission = await submitPiManagerPrompt(
                authenticatedRequest,
                context,
                scope,
                "assistant",
                {
                  requestId: "accepted-prompt",
                  content: "PRIVATE_USER_PROMPT",
                  whenBusy: "reject",
                  whenPaused: "wait",
                  model: null,
                },
              );
              expect(admission).toMatchObject({
                receipt: { requestId: "accepted-prompt" },
                error: null,
              });
              const rejected = await submitPiManagerPrompt(
                authenticatedRequest,
                context,
                scope,
                "missing-agent",
                {
                  requestId: "rejected-prompt",
                  content: "PRIVATE_REJECTED_PROMPT",
                  whenBusy: "reject",
                  whenPaused: "wait",
                  model: null,
                },
              );
              assert(rejected.error !== null);
              await ctx.runtime.drain();
              await shutdownCloudflarePostHog(client);
              expect(
                received.filter((event) => event.event === "agent_prompt_admitted"),
              ).toHaveLength(1);
              const generation = received.filter((event) => event.event === "$ai_generation");
              expect(generation).toHaveLength(1);
              const userId = generation[0].distinct_id;
              expect(userId).not.toMatch(/^pi-agent:/);
              expect(generation[0].uuid).toBe(generation[0].properties.$ai_span_id);
              const agentId = piAgentObjectName({ scope, agentName: "assistant" });
              expect(generation[0].properties).toMatchObject({
                agent_name: "assistant",
                organization_id: organization.id,
                organization_slug: "analytics",
                $ai_session_id: agentId,
                $ai_provider: "faux",
                $ai_model: "faux-1",
                $ai_is_error: false,
                $process_person_profile: false,
              });
              for (const marker of [
                "PRIVATE_USER_PROMPT",
                "PRIVATE_ASSISTANT_OUTPUT",
                "PRIVATE_REJECTED_PROMPT",
              ]) {
                expect(JSON.stringify(received)).not.toContain(marker);
              }

              // Streaming failures can arrive after the request batch has already shut down.
              const lateError = new Error("Late rendering failure");
              captureBackofficeServerException(context, lateError);
              captureBackofficeServerException(context, lateError);
              await Promise.all(deliveries);
              const exceptions = received.filter((event) => event.event === "$exception");
              expect(exceptions).toHaveLength(1);
              expect(exceptions[0].distinct_id).toBe(userId);

              // An unavailable analytics service must not roll back or hide a successful server operation.
              receiverStatus = 503;
              const failedDeliveryClient = new PostHog("phc_scenario", {
                host: `http://127.0.0.1:${address.port}`,
                flushAt: 100,
                flushInterval: 0,
                disableCompression: true,
                fetchRetryCount: 0,
              });
              const analytics = context.get(BackofficePostHogContext);
              assert(analytics);
              context.set(BackofficePostHogContext, { ...analytics, client: failedDeliveryClient });
              const second = await submitPiManagerPrompt(
                authenticatedRequest,
                context,
                scope,
                "assistant",
                {
                  requestId: "second-prompt",
                  content: "PRIVATE_SECOND_PROMPT",
                  whenBusy: "followUp",
                  whenPaused: "wait",
                  model: null,
                },
              );
              await shutdownCloudflarePostHog(failedDeliveryClient);
              expect(second).toMatchObject({
                receipt: { requestId: "second-prompt" },
                error: null,
              });
              const persisted = await fetchPiManagerAgent(
                authenticatedRequest,
                context,
                scope,
                "assistant",
              );
              expect(persisted).toMatchObject({ found: true, agent: { provisioned: true } });
              expect(
                received.filter((event) => event.event === "agent_prompt_admitted"),
              ).toHaveLength(1);
            },
          ),
        ],
      }),
    );
  } finally {
    await Promise.all(deliveries);
    await shutdownCloudflarePostHog(client);
    receiver.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
