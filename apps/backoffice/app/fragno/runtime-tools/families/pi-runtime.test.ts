import { describe, expect, it } from "vitest";

import { InMemoryFs } from "just-bash";

import { createBashHost } from "../bash-host";
import type { AutomationsRuntime } from "./automations";
import {
  createPiRouteRuntime,
  type PiRuntime,
  type PiSessionCreateArgs,
  type PiSessionGetArgs,
  type PiSessionListArgs,
  type PiSessionTurnArgs,
} from "./pi-runtime";

const now = new Date("2026-01-01T00:00:00.000Z");

const createTurnResult = (sessionId: string, assistantText = "assistant:hello") => {
  const assistantMessage = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: assistantText }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: now.getTime(),
  };
  const state = {
    messages: [assistantMessage],
  };
  return {
    id: sessionId,
    name: "support",
    status: "waiting" as const,
    agentName: "assistant",
    workflowName: "interactive-chat-workflow",
    agent: {
      state,
      events: [],
    },
    steeringMode: "one-at-a-time" as const,
    metadata: null,
    tags: [],
    createdAt: now,
    updatedAt: now,
    workflow: {
      status: "waiting" as const,
    },
    assistantText,
    messageStatus: "active" as const,
    stream: [{ type: "snapshot" as const, state }],
    terminalState: state,
  };
};

const createPiRuntime = (overrides: Partial<PiRuntime> = {}): PiRuntime => ({
  createSession: async ({ agent, name, metadata, tags, steeringMode }) => {
    if (agent === "missing") {
      throw new Error("Pi fragment returned 404: Agent not found");
    }

    return {
      id: "session-1",
      name: name ?? null,
      status: "waiting",
      agent,
      workflowName: "interactive-chat-workflow",
      steeringMode: steeringMode ?? "one-at-a-time",
      metadata: metadata ?? null,
      tags: tags ?? [],
      createdAt: now,
      updatedAt: now,
    };
  },
  getSession: async ({ sessionId }) => {
    if (sessionId === "missing") {
      throw new Error("Pi fragment returned 404: Session not found");
    }

    return {
      id: sessionId,
      name: "support",
      status: "waiting",
      agentName: "assistant",
      workflowName: "interactive-chat-workflow",
      agent: {
        state: { messages: [] },
        events: [],
      },
      steeringMode: "one-at-a-time",
      metadata: null,
      tags: [],
      createdAt: now,
      updatedAt: now,
      workflow: {
        status: "waiting",
      },
    };
  },
  listSessions: async (args) => {
    return [
      {
        id: "session-1",
        name: null,
        status: "waiting" as const,
        agent: "assistant",
        workflowName: "interactive-chat-workflow",
        steeringMode: "one-at-a-time" as const,
        metadata: null,
        tags: [] as string[],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "session-2",
        name: null,
        status: "waiting" as const,
        agent: "assistant",
        workflowName: "interactive-chat-workflow",
        steeringMode: "one-at-a-time" as const,
        metadata: null,
        tags: [] as string[],
        createdAt: now,
        updatedAt: now,
      },
    ].slice(0, Math.max(0, args.limit ?? 2));
  },
  runTurn: async ({ sessionId, text }) => {
    if (sessionId === "missing") {
      throw new Error("Pi fragment returned 404: Session not found");
    }

    return createTurnResult(sessionId, `assistant:${text}`);
  },
  ...overrides,
});

const createAutomationsRuntime = (): AutomationsRuntime => ({
  lookupBinding: async ({ key }) => {
    if (key !== "actor-1") {
      return null;
    }

    return {
      source: "telegram",
      key,
      value: "user-1",
      status: "linked",
    };
  },
  bindActor: async ({ source, key, value }) => ({
    source,
    key,
    value,
    status: "linked",
  }),
});

const createPiHost = (piRuntime: PiRuntime = createPiRuntime()) => {
  return createBashHost({
    fs: new InMemoryFs(),
    sessionId: "session-host",
    context: {
      automation: null,
      automations: {
        runtime: createAutomationsRuntime(),
      },
      otp: null,
      pi: {
        runtime: piRuntime,
      },
      reson8: null,
      resend: null,
      telegram: null,
    },
  });
};

const createNdjsonResponse = (frames: unknown[]) => {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    },
  );
};

const createLongLivedNdjsonResponse = (frames: unknown[]) => {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        }
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    },
  );
};

const withTimeout = async <T>(promise: Promise<T>, message: string, ms = 1_000): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);

describe("pi bash command registration", () => {
  it("runs pi.session and automations commands from the pi bash host", async () => {
    const { bash, commandCallsResult } = createPiHost();

    const result = await bash.exec(
      'session_id="$(pi.session.create --agent assistant --name support --tag urgent --print id)"\n' +
        'user_id="$(automations.identity.lookup-binding --source telegram --key actor-1 --print value)"\n' +
        'automations.identity.bind-actor --source telegram --key actor-2 --value "$user_id" >/dev/null\n' +
        'list_id="$(pi.session.list --limit 1 --print 0.id)"\n' +
        'pi.session.get --session-id "$session_id" --print id >/dev/null\n' +
        'pi.session.turn --session-id "$session_id" --text "hello" --print assistantText',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout?.trim()).toBe("assistant:hello");
    expect(commandCallsResult).toEqual([
      {
        command: "pi.session.create",
        output: "session-1",
        exitCode: 0,
      },
      {
        command: "automations.identity.lookup-binding",
        output: "user-1",
        exitCode: 0,
      },
      {
        command: "automations.identity.bind-actor",
        output: "",
        exitCode: 0,
      },
      {
        command: "pi.session.list",
        output: "session-1",
        exitCode: 0,
      },
      {
        command: "pi.session.get",
        output: "session-1",
        exitCode: 0,
      },
      {
        command: "pi.session.turn",
        output: "assistant:hello",
        exitCode: 0,
      },
    ]);
  });

  it("shows standardized help output for pi commands", async () => {
    const { bash, commandCallsResult } = createPiHost();

    const createHelp = await bash.exec("pi.session.create --help");
    const getHelp = await bash.exec("pi.session.get --help");
    const listHelp = await bash.exec("pi.session.list --help");
    const turnHelp = await bash.exec("pi.session.turn --help");

    expect(createHelp.exitCode).toBe(0);
    expect(createHelp.stdout).toContain("pi.session.create");
    expect(createHelp.stdout).toContain("Usage: pi.session.create [options]");
    expect(createHelp.stdout).toContain("--agent <agent>");
    expect(createHelp.stdout).toContain("--help");
    expect(createHelp.stdout).toContain("--print <selector>");
    expect(createHelp.stdout).toContain("--format <format>");
    expect(createHelp.stdout).toContain("Examples:");

    expect(getHelp.exitCode).toBe(0);
    expect(getHelp.stdout).toContain("pi.session.get");
    expect(getHelp.stdout).toContain("Usage: pi.session.get [options]");
    expect(getHelp.stdout).toContain("--session-id <session-id>");
    expect(getHelp.stdout).toContain("--events");
    expect(getHelp.stdout).toContain("--trace");
    expect(getHelp.stdout).toContain("--turns");
    expect(getHelp.stdout).toContain("--help");
    expect(getHelp.stdout).toContain("--print <selector>");
    expect(getHelp.stdout).toContain("--format <format>");

    expect(listHelp.exitCode).toBe(0);
    expect(listHelp.stdout).toContain("pi.session.list");
    expect(listHelp.stdout).toContain("Usage: pi.session.list [options]");
    expect(listHelp.stdout).toContain("--limit <limit>");
    expect(listHelp.stdout).toContain("--help");
    expect(listHelp.stdout).toContain("--print <selector>");
    expect(listHelp.stdout).toContain("--format <format>");

    expect(turnHelp.exitCode).toBe(0);
    expect(turnHelp.stdout).toContain("pi.session.turn");
    expect(turnHelp.stdout).toContain("Usage: pi.session.turn [options]");
    expect(turnHelp.stdout).toContain("--session-id <session-id>");
    expect(turnHelp.stdout).toContain("--text <text>");
    expect(turnHelp.stdout).toContain("--help");
    expect(turnHelp.stdout).toContain("--print <selector>");
    expect(turnHelp.stdout).toContain("--format <format>");

    expect(commandCallsResult).toEqual([
      {
        command: "pi.session.create",
        output: expect.stringContaining("pi.session.create"),
        exitCode: 0,
      },
      {
        command: "pi.session.get",
        output: expect.stringContaining("pi.session.get"),
        exitCode: 0,
      },
      {
        command: "pi.session.list",
        output: expect.stringContaining("pi.session.list"),
        exitCode: 0,
      },
      {
        command: "pi.session.turn",
        output: expect.stringContaining("pi.session.turn"),
        exitCode: 0,
      },
    ]);
  });

  it("supports text, json, and --print output behavior for pi commands", async () => {
    const createCalls: PiSessionCreateArgs[] = [];
    const getCalls: PiSessionGetArgs[] = [];
    const listCalls: PiSessionListArgs[] = [];
    const turnCalls: PiSessionTurnArgs[] = [];
    const { bash, commandCallsResult } = createPiHost(
      createPiRuntime({
        createSession: async (args) => {
          createCalls.push(args);
          return {
            id: "session-1",
            name: args.name ?? null,
            status: "waiting",
            agent: args.agent,
            workflowName: "interactive-chat-workflow",
            steeringMode: args.steeringMode ?? "one-at-a-time",
            metadata: args.metadata ?? null,
            tags: args.tags ?? [],
            createdAt: now,
            updatedAt: now,
          };
        },
        getSession: async (args) => {
          getCalls.push(args);
          return {
            id: args.sessionId,
            name: "support",
            status: "waiting",
            agentName: "assistant",
            workflowName: "interactive-chat-workflow",
            agent: {
              state: { messages: [] },
              events: [],
            },
            steeringMode: "one-at-a-time",
            metadata: null,
            tags: [],
            createdAt: now,
            updatedAt: now,
            workflow: {
              status: "waiting",
            },
          };
        },
        listSessions: async (args) => {
          listCalls.push(args);
          return [
            {
              id: "session-1",
              name: "support",
              status: "waiting",
              agent: "assistant",
              workflowName: "interactive-chat-workflow",
              steeringMode: "one-at-a-time",
              metadata: { source: "test" },
              tags: ["alpha"],
              createdAt: now,
              updatedAt: now,
            },
          ];
        },
        runTurn: async (args) => {
          turnCalls.push(args);
          return createTurnResult(args.sessionId, `assistant:${args.text}`);
        },
      }),
    );

    const result = await bash.exec(
      [
        `printf "text=%s\\n" "$(pi.session.create --agent assistant --name support --metadata-json '{"team":"alpha"}' --tag urgent --steering-mode one-at-a-time --format text)"`,
        `printf "json=%s\\n" "$(pi.session.create --agent assistant --name support --metadata-json '{"team":"alpha"}' --tag urgent --steering-mode one-at-a-time --format json)"`,
        `printf "print=%s\\n" "$(pi.session.create --agent assistant --steering-mode one-at-a-time --print steering-mode)"`,
        `printf "workflow=%s\\n" "$(pi.session.get --session-id session-1 --events --trace false --turns true --print workflow.status)"`,
        `printf "list_print=%s\\n" "$(pi.session.list --limit 1 --format json --print 0.id)"`,
        `printf "list_text=%s\\n" "$(pi.session.list --limit 1 --format text)"`,
        `printf "list=%s\\n" "$(pi.session.list --limit 1)"`,
        `printf "turn_print=%s\\n" "$(pi.session.turn --session-id session-1 --text 'hello world' --print assistantText)"`,
        `printf "turn_json=%s\\n" "$(pi.session.turn --session-id session-1 --text 'hello world' --format json)"`,
        `printf "turn=%s\\n" "$(pi.session.turn --session-id session-1 --text 'hello world')"`,
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    const outputLines = result.stdout?.trim().split("\n") ?? [];
    expect(outputLines[0]).toBe("text=");
    expect(outputLines[2]).toBe("print=one-at-a-time");
    expect(outputLines[3]).toBe("workflow=waiting");
    expect(outputLines[4]).toBe("list_print=session-1");
    expect(outputLines[5]).toBe("list_text=");
    expect(outputLines[7]).toBe("turn_print=assistant:hello world");

    const defaultListLine = outputLines[6]?.replace(/^list=/, "");
    expect(JSON.parse(defaultListLine ?? "null")).toMatchObject([
      {
        id: "session-1",
        name: "support",
        status: "waiting",
        agent: "assistant",
        workflowName: "interactive-chat-workflow",
        steeringMode: "one-at-a-time",
        metadata: { source: "test" },
        tags: ["alpha"],
      },
    ]);

    const jsonLine = outputLines[1]?.replace(/^json=/, "");
    expect(JSON.parse(jsonLine ?? "null")).toMatchObject({
      id: "session-1",
      agent: "assistant",
      workflowName: "interactive-chat-workflow",
      name: "support",
      steeringMode: "one-at-a-time",
      metadata: {
        team: "alpha",
      },
      tags: ["urgent"],
    });

    const turnJsonLine = outputLines[8]?.replace(/^turn_json=/, "");
    expect(JSON.parse(turnJsonLine ?? "null")).toMatchObject({
      id: "session-1",
      assistantText: "assistant:hello world",
      workflow: {
        status: "waiting",
      },
      terminalState: {
        messages: expect.any(Array),
      },
    });

    const defaultTurnLine = outputLines[9]?.replace(/^turn=/, "");
    expect(JSON.parse(defaultTurnLine ?? "null")).toMatchObject({
      id: "session-1",
      assistantText: "assistant:hello world",
      messageStatus: "active",
    });

    expect(createCalls).toEqual([
      {
        agent: "assistant",
        name: "support",
        metadata: { team: "alpha" },
        tags: ["urgent"],
        steeringMode: "one-at-a-time",
        systemMessage: undefined,
      },
      {
        agent: "assistant",
        name: "support",
        metadata: { team: "alpha" },
        tags: ["urgent"],
        steeringMode: "one-at-a-time",
        systemMessage: undefined,
      },
      {
        agent: "assistant",
        name: undefined,
        metadata: undefined,
        tags: undefined,
        steeringMode: "one-at-a-time",
        systemMessage: undefined,
      },
    ]);
    expect(getCalls).toEqual([
      {
        sessionId: "session-1",
        events: true,
        trace: false,
        turns: true,
      },
    ]);
    expect(listCalls).toEqual([{ limit: 1 }, { limit: 1 }, { limit: 1 }]);
    expect(turnCalls).toEqual([
      {
        sessionId: "session-1",
        text: "hello world",
        steeringMode: undefined,
      },
      {
        sessionId: "session-1",
        text: "hello world",
        steeringMode: undefined,
      },
      {
        sessionId: "session-1",
        text: "hello world",
        steeringMode: undefined,
      },
    ]);
    expect(commandCallsResult).toEqual([
      {
        command: "pi.session.create",
        output: "",
        exitCode: 0,
      },
      {
        command: "pi.session.create",
        output: expect.stringContaining('"id":"session-1"'),
        exitCode: 0,
      },
      {
        command: "pi.session.create",
        output: "one-at-a-time",
        exitCode: 0,
      },
      {
        command: "pi.session.get",
        output: "waiting",
        exitCode: 0,
      },
      {
        command: "pi.session.list",
        output: "session-1",
        exitCode: 0,
      },
      {
        command: "pi.session.list",
        output: "",
        exitCode: 0,
      },
      {
        command: "pi.session.list",
        output: expect.stringContaining("[{"),
        exitCode: 0,
      },
      {
        command: "pi.session.turn",
        output: "assistant:hello world",
        exitCode: 0,
      },
      {
        command: "pi.session.turn",
        output: expect.stringContaining('"assistantText":"assistant:hello world"'),
        exitCode: 0,
      },
      {
        command: "pi.session.turn",
        output: expect.stringContaining('"assistantText":"assistant:hello world"'),
        exitCode: 0,
      },
    ]);
  });

  it("returns parse failures for invalid pi command arguments", async () => {
    const { bash, commandCallsResult } = createPiHost();

    const missingSession = await bash.exec("pi.session.get");
    const invalidLimit = await bash.exec("pi.session.list --limit not-a-number");
    const repeatedEvents = await bash.exec(
      "pi.session.get --session-id session-1 --events false --events true",
    );
    const missingTurnText = await bash.exec("pi.session.turn --session-id session-1");
    expect(missingSession.exitCode).toBe(1);
    expect(missingSession.stderr).toContain("Missing required option --session-id");
    expect(invalidLimit.exitCode).toBe(1);
    expect(invalidLimit.stderr).toContain("--limit must be an integer");
    expect(repeatedEvents.exitCode).toBe(1);
    expect(repeatedEvents.stderr).toContain("--events specified multiple times");
    expect(missingTurnText.exitCode).toBe(1);
    expect(missingTurnText.stderr).toContain("Missing required option --text");
    expect(commandCallsResult).toEqual([
      {
        command: "pi.session.get",
        output: "",
        exitCode: 1,
      },
      {
        command: "pi.session.list",
        output: "",
        exitCode: 1,
      },
      {
        command: "pi.session.get",
        output: "",
        exitCode: 1,
      },
      {
        command: "pi.session.turn",
        output: "",
        exitCode: 1,
      },
    ]);
  });

  it("surfaces runtime failures from pi command handlers", async () => {
    const { bash, commandCallsResult } = createPiHost(
      createPiRuntime({
        listSessions: async () => {
          throw new Error("Pi fragment returned 404: No sessions found");
        },
      }),
    );

    const createResult = await bash.exec("pi.session.create --agent missing");
    const getResult = await bash.exec("pi.session.get --session-id missing");
    const listResult = await bash.exec("pi.session.list");
    const turnResult = await bash.exec("pi.session.turn --session-id missing --text hello");

    expect(createResult.exitCode).toBe(1);
    expect(createResult.stderr).toContain("Pi fragment returned 404: Agent not found");
    expect(getResult.exitCode).toBe(1);
    expect(getResult.stderr).toContain("Pi fragment returned 404: Session not found");
    expect(listResult.exitCode).toBe(1);
    expect(listResult.stderr).toContain("Pi fragment returned 404: No sessions found");
    expect(turnResult.exitCode).toBe(1);
    expect(turnResult.stderr).toContain("Pi fragment returned 404: Session not found");
    expect(commandCallsResult).toEqual([
      {
        command: "pi.session.create",
        output: "",
        exitCode: 1,
      },
      {
        command: "pi.session.get",
        output: "",
        exitCode: 1,
      },
      {
        command: "pi.session.list",
        output: "",
        exitCode: 1,
      },
      {
        command: "pi.session.turn",
        output: "",
        exitCode: 1,
      },
    ]);
  });

  it("omits automation event commands from the pi bash host", async () => {
    const { bash, commandCallsResult } = createPiHost();

    const result = await bash.exec("event.emit --event-type test.event");

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("bash: event.emit: command not found");
    expect(commandCallsResult).toEqual([]);
  });
});

describe("createPiRouteRuntime", () => {
  it("calls Pi routes with the expected payloads and query params", async () => {
    const requests: Array<{
      url: string;
      method: string;
      body?: unknown;
    }> = [];

    const env = {
      PI: {
        idFromName: (orgId: string) => `pi:${orgId}`,
        get: () => ({
          fetch: async (request: Request) => {
            requests.push({
              url: request.url,
              method: request.method,
              body: request.method === "POST" ? await request.clone().json() : undefined,
            });

            const url = new URL(request.url);
            const path = `${url.pathname}${url.search}`;

            if (
              path === "/api/pi/workflows/interactive-chat-workflow/sessions?orgId=acme" &&
              request.method === "POST"
            ) {
              return new Response(
                JSON.stringify({
                  id: "session-2",
                  agent: "assistant",
                  workflowName: "interactive-chat-workflow",
                  status: "waiting",
                  name: "route-session",
                  steeringMode: "all",
                  metadata: { team: "beta" },
                  tags: ["priority"],
                  createdAt: now.toISOString(),
                  updatedAt: now.toISOString(),
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              );
            }

            if (
              path ===
                "/api/pi/workflows/interactive-chat-workflow/sessions/session-2?events=true&trace=false&turns=true&orgId=acme" &&
              request.method === "GET"
            ) {
              return new Response(
                JSON.stringify({
                  id: "session-2",
                  agentName: "assistant",
                  workflowName: "interactive-chat-workflow",
                  agent: {
                    state: { messages: [] },
                    events: [{ id: "event-1" }],
                  },
                  status: "waiting",
                  name: "route-session",
                  steeringMode: "all",
                  metadata: { team: "beta" },
                  tags: ["priority"],
                  createdAt: now.toISOString(),
                  updatedAt: now.toISOString(),
                  workflow: { status: "waiting" },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              );
            }

            if (
              path ===
                "/api/pi/workflows/interactive-chat-workflow/sessions/session-2/events?orgId=acme" &&
              request.method === "GET"
            ) {
              return createNdjsonResponse([
                {
                  type: "snapshot",
                  state: { messages: [] },
                },
                { type: "messageStart", timestamp: now.getTime() },
              ]);
            }

            if (
              path ===
                "/api/pi/workflows/interactive-chat-workflow/sessions/session-2/command?orgId=acme" &&
              request.method === "POST"
            ) {
              return new Response(JSON.stringify({ status: "active" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }

            if (
              path ===
                "/api/pi/workflows/interactive-chat-workflow/sessions/session-2?orgId=acme" &&
              request.method === "GET"
            ) {
              return new Response(
                JSON.stringify({
                  id: "session-2",
                  agentName: "assistant",
                  workflowName: "interactive-chat-workflow",
                  agent: {
                    state: {
                      messages: [
                        {
                          role: "assistant",
                          content: [{ type: "text", text: "assistant:route-turn" }],
                          api: "openai-responses",
                          provider: "openai",
                          model: "test-model",
                          usage: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            totalTokens: 0,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                          },
                          stopReason: "stop",
                          timestamp: now.getTime(),
                        },
                      ],
                    },
                    events: [],
                  },
                  status: "waiting",
                  name: "route-session",
                  steeringMode: "all",
                  metadata: { team: "beta" },
                  tags: ["priority"],
                  createdAt: now.toISOString(),
                  updatedAt: now.toISOString(),
                  workflow: { status: "waiting" },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              );
            }

            if (
              path === "/api/pi/workflows/interactive-chat-workflow/sessions?limit=10&orgId=acme" &&
              request.method === "GET"
            ) {
              return new Response(
                JSON.stringify([
                  {
                    id: "session-2",
                    agent: "assistant",
                    workflowName: "interactive-chat-workflow",
                    status: "waiting",
                    name: "route-session",
                    steeringMode: "all",
                    metadata: { team: "beta" },
                    tags: ["priority"],
                    createdAt: now.toISOString(),
                    updatedAt: now.toISOString(),
                  },
                ]),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              );
            }

            return new Response(JSON.stringify({ message: "unexpected request" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      },
    } as unknown as CloudflareEnv;

    const runtime = createPiRouteRuntime({ env, orgId: "acme" });

    const created = await runtime.createSession({
      agent: "assistant",
      name: "route-session",
      metadata: { team: "beta" },
      tags: ["priority"],
      steeringMode: "all",
    });
    const loaded = await runtime.getSession({
      sessionId: "session-2",
      events: true,
      trace: false,
      turns: true,
    });
    const sessions = await runtime.listSessions({
      limit: 10,
    });
    const turned = await runtime.runTurn({
      sessionId: "session-2",
      text: "route turn",
    });

    expect(created).toMatchObject({
      id: "session-2",
      name: "route-session",
      agent: "assistant",
      workflowName: "interactive-chat-workflow",
      steeringMode: "all",
      metadata: { team: "beta" },
      tags: ["priority"],
    });
    expect(loaded).toMatchObject({
      id: "session-2",
      workflow: { status: "waiting" },
      agentName: "assistant",
      workflowName: "interactive-chat-workflow",
      agent: { events: [{ id: "event-1" }] },
    });
    expect(sessions).toEqual([
      {
        id: "session-2",
        agent: "assistant",
        workflowName: "interactive-chat-workflow",
        status: "waiting",
        name: "route-session",
        steeringMode: "all",
        metadata: { team: "beta" },
        tags: ["priority"],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ]);
    expect(turned).toMatchObject({
      id: "session-2",
      assistantText: "assistant:route-turn",
      messageStatus: "active",
      workflow: { status: "waiting" },
      terminalState: {
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "assistant:route-turn" }],
          }),
        ]),
      },
    });
    expect(turned.stream).toEqual([
      expect.objectContaining({ type: "snapshot" }),
      expect.objectContaining({ type: "messageStart" }),
    ]);
    expect(requests).toEqual([
      {
        url: "https://pi.do/api/pi/workflows/interactive-chat-workflow/sessions?orgId=acme",
        method: "POST",
        body: {
          name: "route-session",
          input: { agentName: "assistant" },
        },
      },
      {
        url: "https://pi.do/api/pi/workflows/interactive-chat-workflow/sessions/session-2?events=true&trace=false&turns=true&orgId=acme",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://pi.do/api/pi/workflows/interactive-chat-workflow/sessions?limit=10&orgId=acme",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://pi.do/api/pi/workflows/interactive-chat-workflow/sessions/session-2/events?orgId=acme",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://pi.do/api/pi/workflows/interactive-chat-workflow/sessions/session-2/command?orgId=acme",
        method: "POST",
        body: {
          kind: "prompt",
          input: { text: "route turn" },
        },
      },
      {
        url: "https://pi.do/api/pi/workflows/interactive-chat-workflow/sessions/session-2?orgId=acme",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("stops pi.session.turn stream consumption at turn_end", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "assistant:done" }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: now.getTime(),
    };

    const env = {
      PI: {
        idFromName: (orgId: string) => `pi:${orgId}`,
        get: () => ({
          fetch: async (request: Request) => {
            requests.push({ url: request.url, method: request.method });
            const url = new URL(request.url);
            const path = `${url.pathname}${url.search}`;

            if (
              path ===
              "/api/pi/workflows/interactive-chat-workflow/sessions/session-2/events?orgId=acme"
            ) {
              return createLongLivedNdjsonResponse([
                { type: "snapshot", state: { messages: [] } },
                { type: "message_end", message: assistantMessage },
                { type: "turn_end" },
                { type: "agent_end" },
              ]);
            }

            if (
              path ===
              "/api/pi/workflows/interactive-chat-workflow/sessions/session-2/command?orgId=acme"
            ) {
              return new Response(JSON.stringify({ status: "active" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }

            if (
              path === "/api/pi/workflows/interactive-chat-workflow/sessions/session-2?orgId=acme"
            ) {
              return new Response(
                JSON.stringify({
                  id: "session-2",
                  agentName: "assistant",
                  workflowName: "interactive-chat-workflow",
                  agent: { state: { messages: [assistantMessage] }, events: [] },
                  status: "waiting",
                  name: "route-session",
                  steeringMode: "all",
                  metadata: null,
                  tags: [],
                  createdAt: now.toISOString(),
                  updatedAt: now.toISOString(),
                  workflow: { status: "waiting" },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }

            return new Response(JSON.stringify({ message: "unexpected request" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      },
    } as unknown as CloudflareEnv;

    const runtime = createPiRouteRuntime({ env, orgId: "acme" });
    const turned = await withTimeout(
      runtime.runTurn({ sessionId: "session-2", text: "hello" }),
      "runTurn should not wait for the live events stream to close",
    );

    expect(turned.assistantText).toBe("assistant:done");
    expect(turned.stream).toEqual([
      expect.objectContaining({ type: "snapshot" }),
      expect.objectContaining({ type: "message_end" }),
      expect.objectContaining({ type: "turn_end" }),
    ]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://pi.do/api/pi/workflows/interactive-chat-workflow/sessions/session-2/events?orgId=acme",
      "https://pi.do/api/pi/workflows/interactive-chat-workflow/sessions/session-2/command?orgId=acme",
      "https://pi.do/api/pi/workflows/interactive-chat-workflow/sessions/session-2?orgId=acme",
    ]);
  });

  it("turns Pi route failures into command-friendly errors", async () => {
    const env = {
      PI: {
        idFromName: (orgId: string) => `pi:${orgId}`,
        get: () => ({
          fetch: async (request: Request) => {
            const url = new URL(request.url);
            const path = `${url.pathname}${url.search}`;

            if (
              path === "/api/pi/workflows/interactive-chat-workflow/sessions?orgId=acme" &&
              request.method === "POST"
            ) {
              return new Response(JSON.stringify({ message: "Agent not found" }), {
                status: 404,
                headers: { "content-type": "application/json" },
              });
            }

            return new Response(JSON.stringify({ message: "Session not found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      },
    } as unknown as CloudflareEnv;

    const runtime = createPiRouteRuntime({ env, orgId: "acme" });

    await expect(runtime.createSession({ agent: "missing" })).rejects.toThrow(
      "Pi fragment returned 404: Agent not found",
    );
    await expect(runtime.getSession({ sessionId: "missing" })).rejects.toThrow(
      "Pi fragment returned 404: Session not found",
    );
    await expect(runtime.listSessions({ limit: 5 })).rejects.toThrow(
      "Pi fragment returned 404: Session not found",
    );
    await expect(runtime.runTurn({ sessionId: "missing", text: "hello" })).rejects.toThrow(
      "Pi fragment returned 404: Session not found",
    );
  });

  it("rejects pi.session.turn when the active route does not return a stream", async () => {
    const env = {
      PI: {
        idFromName: (orgId: string) => `pi:${orgId}`,
        get: () => ({
          fetch: async (request: Request) => {
            const url = new URL(request.url);
            const path = `${url.pathname}${url.search}`;

            if (
              path ===
                "/api/pi/workflows/interactive-chat-workflow/sessions/session-2/events?orgId=acme" &&
              request.method === "GET"
            ) {
              return new Response(JSON.stringify({ status: "waiting" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }

            return new Response(JSON.stringify({ message: "unexpected request" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      },
    } as unknown as CloudflareEnv;

    const runtime = createPiRouteRuntime({ env, orgId: "acme" });

    await expect(runtime.runTurn({ sessionId: "session-2", text: "hello" })).rejects.toThrow(
      "session events route did not return a jsonStream response",
    );
  });

  it("surfaces pi.session.turn prompt route failures", async () => {
    const env = {
      PI: {
        idFromName: (orgId: string) => `pi:${orgId}`,
        get: () => ({
          fetch: async (request: Request) => {
            const url = new URL(request.url);
            const path = `${url.pathname}${url.search}`;

            if (
              path ===
                "/api/pi/workflows/interactive-chat-workflow/sessions/session-2/events?orgId=acme" &&
              request.method === "GET"
            ) {
              return createNdjsonResponse([
                {
                  layer: "system",
                  type: "snapshot",
                  turn: 0,
                  phase: "waiting-for-command",
                  waitingFor: null,
                  replayCount: 0,
                },
              ]);
            }

            if (
              path ===
                "/api/pi/workflows/interactive-chat-workflow/sessions/session-2/command?orgId=acme" &&
              request.method === "POST"
            ) {
              return new Response(JSON.stringify({ message: "Session not ready" }), {
                status: 409,
                headers: { "content-type": "application/json" },
              });
            }

            return new Response(JSON.stringify({ message: "unexpected request" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      },
    } as unknown as CloudflareEnv;

    const runtime = createPiRouteRuntime({ env, orgId: "acme" });

    await expect(runtime.runTurn({ sessionId: "session-2", text: "hello" })).rejects.toThrow(
      "Pi fragment returned 409: Session not ready",
    );
  });

  it("surfaces pi.session.turn detail fetch failures after the stream settles", async () => {
    const env = {
      PI: {
        idFromName: (orgId: string) => `pi:${orgId}`,
        get: () => ({
          fetch: async (request: Request) => {
            const url = new URL(request.url);
            const path = `${url.pathname}${url.search}`;

            if (
              path ===
                "/api/pi/workflows/interactive-chat-workflow/sessions/session-2/events?orgId=acme" &&
              request.method === "GET"
            ) {
              return createNdjsonResponse([
                {
                  layer: "system",
                  type: "snapshot",
                  turn: 0,
                  phase: "running-agent",
                  waitingFor: null,
                  replayCount: 0,
                },
              ]);
            }

            if (
              path ===
                "/api/pi/workflows/interactive-chat-workflow/sessions/session-2/command?orgId=acme" &&
              request.method === "POST"
            ) {
              return new Response(JSON.stringify({ status: "active" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }

            if (
              path ===
                "/api/pi/workflows/interactive-chat-workflow/sessions/session-2?orgId=acme" &&
              request.method === "GET"
            ) {
              return new Response(JSON.stringify({ message: "Detail unavailable" }), {
                status: 500,
                headers: { "content-type": "application/json" },
              });
            }

            return new Response(JSON.stringify({ message: "unexpected request" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      },
    } as unknown as CloudflareEnv;

    const runtime = createPiRouteRuntime({ env, orgId: "acme" });

    await expect(runtime.runTurn({ sessionId: "session-2", text: "hello" })).rejects.toThrow(
      "Pi fragment returned 500: Detail unavailable",
    );
  });
});
