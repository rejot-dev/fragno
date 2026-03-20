import { describe, expect, it } from "vitest";

import { InMemoryFs } from "just-bash";

import type { AutomationsBashRuntime } from "./automation/automations-bash-runtime";
import { createBashHost } from "./bash-host";
import {
  createPiRouteBashRuntime,
  type PiBashRuntime,
  type PiSessionCreateArgs,
  type PiSessionGetArgs,
  type PiSessionListArgs,
} from "./pi-bash-runtime";

const now = new Date("2026-01-01T00:00:00.000Z");

const createPiRuntime = (overrides: Partial<PiBashRuntime> = {}): PiBashRuntime => ({
  createSession: async ({ agent, name, metadata, tags, steeringMode }) => {
    if (agent === "missing") {
      throw new Error("Pi fragment returned 404: Agent not found");
    }

    return {
      id: "session-1",
      name: name ?? null,
      status: "waiting",
      agent,
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
      agent: "assistant",
      steeringMode: "one-at-a-time",
      metadata: null,
      tags: [],
      createdAt: now,
      updatedAt: now,
      workflow: {
        status: "waiting",
      },
      messages: [],
      events: [],
      trace: [],
      summaries: [],
      turn: 0,
      phase: "waiting-for-user",
      waitingFor: null,
    };
  },
  listSessions: async (args) => {
    return [
      {
        id: "session-1",
        name: null,
        status: "waiting" as const,
        agent: "assistant",
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
        steeringMode: "one-at-a-time" as const,
        metadata: null,
        tags: [] as string[],
        createdAt: now,
        updatedAt: now,
      },
    ].slice(0, Math.max(0, args.limit ?? 2));
  },
  ...overrides,
});

const createAutomationsRuntime = (): AutomationsBashRuntime => ({
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

const createPiHost = (piRuntime: PiBashRuntime = createPiRuntime()) => {
  return createBashHost({
    fs: new InMemoryFs(),
    sessionId: "session-host",
    context: {
      pi: {
        runtime: piRuntime,
      },
      automations: {
        runtime: createAutomationsRuntime(),
      },
    },
  });
};

describe("pi bash command registration", () => {
  it("runs pi.session and automations commands from the pi bash host", async () => {
    const { bash, commandCallsResult } = createPiHost();

    const result = await bash.exec(
      'session_id="$(pi.session.create --agent assistant --name support --tag urgent --print id)"\n' +
        'user_id="$(automations.identity.lookup-binding --source telegram --key actor-1 --print value)"\n' +
        'automations.identity.bind-actor --source telegram --key actor-2 --value "$user_id" >/dev/null\n' +
        'list_id="$(pi.session.list --limit 1 --print 0.id)"\n' +
        'pi.session.get --session-id "$session_id" --print id',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout?.trim()).toBe("session-1");
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
    ]);
  });

  it("shows standardized help output for pi commands", async () => {
    const { bash, commandCallsResult } = createPiHost();

    const createHelp = await bash.exec("pi.session.create --help");
    const getHelp = await bash.exec("pi.session.get --help");
    const listHelp = await bash.exec("pi.session.list --help");

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
    expect(getHelp.stdout).toContain("--summaries");
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
    ]);
  });

  it("supports text, json, and --print output behavior for pi commands", async () => {
    const createCalls: PiSessionCreateArgs[] = [];
    const getCalls: PiSessionGetArgs[] = [];
    const listCalls: PiSessionListArgs[] = [];
    const { bash, commandCallsResult } = createPiHost(
      createPiRuntime({
        createSession: async (args) => {
          createCalls.push(args);
          return {
            id: "session-1",
            name: args.name ?? null,
            status: "waiting",
            agent: args.agent,
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
            agent: "assistant",
            steeringMode: "one-at-a-time",
            metadata: null,
            tags: [],
            createdAt: now,
            updatedAt: now,
            workflow: {
              status: "waiting",
            },
            messages: [],
            events: [],
            trace: [],
            summaries: [],
            turn: 0,
            phase: "waiting-for-user",
            waitingFor: null,
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
              steeringMode: "one-at-a-time",
              metadata: { source: "test" },
              tags: ["alpha"],
              createdAt: now,
              updatedAt: now,
            },
          ];
        },
      }),
    );

    const result = await bash.exec(
      [
        `printf "text=%s\\n" "$(pi.session.create --agent assistant --name support --metadata-json '{"team":"alpha"}' --tag urgent --steering-mode one-at-a-time --format text)"`,
        `printf "json=%s\\n" "$(pi.session.create --agent assistant --name support --metadata-json '{"team":"alpha"}' --tag urgent --steering-mode one-at-a-time --format json)"`,
        `printf "print=%s\\n" "$(pi.session.create --agent assistant --steering-mode one-at-a-time --print steering-mode)"`,
        `printf "workflow=%s\\n" "$(pi.session.get --session-id session-1 --events --trace false --summaries true --print workflow.status)"`,
        `printf "list_print=%s\\n" "$(pi.session.list --limit 1 --format json --print 0.id)"`,
        `printf "list_text=%s\\n" "$(pi.session.list --limit 1 --format text)"`,
        `printf "list=%s\\n" "$(pi.session.list --limit 1)"`,
      ].join("\n"),
    );

    expect(result.exitCode).toBe(0);
    const outputLines = result.stdout?.trim().split("\n") ?? [];
    expect(outputLines[0]).toBe("text=");
    expect(outputLines[2]).toBe("print=one-at-a-time");
    expect(outputLines[3]).toBe("workflow=waiting");
    expect(outputLines[4]).toBe("list_print=session-1");
    expect(outputLines[5]).toBe("list_text=");

    const defaultListLine = outputLines[6]?.replace(/^list=/, "");
    expect(JSON.parse(defaultListLine ?? "null")).toMatchObject([
      {
        id: "session-1",
        name: "support",
        status: "waiting",
        agent: "assistant",
        steeringMode: "one-at-a-time",
        metadata: { source: "test" },
        tags: ["alpha"],
      },
    ]);

    const jsonLine = outputLines[1]?.replace(/^json=/, "");
    expect(JSON.parse(jsonLine ?? "null")).toMatchObject({
      id: "session-1",
      agent: "assistant",
      name: "support",
      steeringMode: "one-at-a-time",
      metadata: {
        team: "alpha",
      },
      tags: ["urgent"],
    });

    expect(createCalls).toEqual([
      {
        agent: "assistant",
        name: "support",
        metadata: { team: "alpha" },
        tags: ["urgent"],
        steeringMode: "one-at-a-time",
      },
      {
        agent: "assistant",
        name: "support",
        metadata: { team: "alpha" },
        tags: ["urgent"],
        steeringMode: "one-at-a-time",
      },
      {
        agent: "assistant",
        name: undefined,
        metadata: undefined,
        tags: undefined,
        steeringMode: "one-at-a-time",
      },
    ]);
    expect(getCalls).toEqual([
      {
        sessionId: "session-1",
        events: true,
        trace: false,
        summaries: true,
      },
    ]);
    expect(listCalls).toEqual([{ limit: 1 }, { limit: 1 }, { limit: 1 }]);
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
    ]);
  });

  it("returns parse failures for invalid pi command arguments", async () => {
    const { bash, commandCallsResult } = createPiHost();

    const missingSession = await bash.exec("pi.session.get");
    const invalidLimit = await bash.exec("pi.session.list --limit not-a-number");
    const repeatedEvents = await bash.exec(
      "pi.session.get --session-id session-1 --events false --events true",
    );

    expect(missingSession.exitCode).toBe(1);
    expect(missingSession.stderr).toContain("Missing required option --session-id");
    expect(invalidLimit.exitCode).toBe(1);
    expect(invalidLimit.stderr).toContain("--limit must be an integer");
    expect(repeatedEvents.exitCode).toBe(1);
    expect(repeatedEvents.stderr).toContain("--events specified multiple times");
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

    expect(createResult.exitCode).toBe(1);
    expect(createResult.stderr).toContain("Pi fragment returned 404: Agent not found");
    expect(getResult.exitCode).toBe(1);
    expect(getResult.stderr).toContain("Pi fragment returned 404: Session not found");
    expect(listResult.exitCode).toBe(1);
    expect(listResult.stderr).toContain("Pi fragment returned 404: No sessions found");
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
    ]);
  });

  it("omits automation event commands from the pi bash host", async () => {
    const { bash, commandCallsResult } = createPiHost();

    const result = await bash.exec('event.reply --text "hello"');

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("bash: event.reply: command not found");
    expect(commandCallsResult).toEqual([]);
  });
});

describe("createPiRouteBashRuntime", () => {
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

            if (path === "/api/pi/sessions?orgId=acme" && request.method === "POST") {
              return new Response(
                JSON.stringify({
                  id: "session-2",
                  agent: "assistant",
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
                "/api/pi/sessions/session-2?events=true&trace=false&summaries=true&orgId=acme" &&
              request.method === "GET"
            ) {
              return new Response(
                JSON.stringify({
                  id: "session-2",
                  agent: "assistant",
                  status: "waiting",
                  name: "route-session",
                  steeringMode: "all",
                  metadata: { team: "beta" },
                  tags: ["priority"],
                  createdAt: now.toISOString(),
                  updatedAt: now.toISOString(),
                  workflow: { status: "waiting" },
                  messages: [],
                  events: [{ id: "event-1" }],
                  trace: [],
                  summaries: [{ text: "summary" }],
                  turn: 0,
                  phase: "waiting-for-user",
                  waitingFor: null,
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              );
            }

            if (path === "/api/pi/sessions?limit=10&orgId=acme" && request.method === "GET") {
              return new Response(
                JSON.stringify([
                  {
                    id: "session-2",
                    agent: "assistant",
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

    const runtime = createPiRouteBashRuntime({ env, orgId: "acme" });

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
      summaries: true,
    });
    const sessions = await runtime.listSessions({
      limit: 10,
    });

    expect(created).toMatchObject({
      id: "session-2",
      name: "route-session",
      agent: "assistant",
      steeringMode: "all",
      metadata: { team: "beta" },
      tags: ["priority"],
    });
    expect(loaded).toMatchObject({
      id: "session-2",
      workflow: { status: "waiting" },
      events: [{ id: "event-1" }],
      summaries: [{ text: "summary" }],
    });
    expect(sessions).toEqual([
      {
        id: "session-2",
        agent: "assistant",
        status: "waiting",
        name: "route-session",
        steeringMode: "all",
        metadata: { team: "beta" },
        tags: ["priority"],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ]);
    expect(requests).toEqual([
      {
        url: "https://pi.do/api/pi/sessions?orgId=acme",
        method: "POST",
        body: {
          agent: "assistant",
          name: "route-session",
          metadata: { team: "beta" },
          tags: ["priority"],
          steeringMode: "all",
        },
      },
      {
        url: "https://pi.do/api/pi/sessions/session-2?events=true&trace=false&summaries=true&orgId=acme",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://pi.do/api/pi/sessions?limit=10&orgId=acme",
        method: "GET",
        body: undefined,
      },
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

            if (path === "/api/pi/sessions?orgId=acme" && request.method === "POST") {
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

    const runtime = createPiRouteBashRuntime({ env, orgId: "acme" });

    await expect(runtime.createSession({ agent: "missing" })).rejects.toThrow(
      "Pi fragment returned 404: Agent not found",
    );
    await expect(runtime.getSession({ sessionId: "missing" })).rejects.toThrow(
      "Pi fragment returned 404: Session not found",
    );
    await expect(runtime.listSessions({ limit: 5 })).rejects.toThrow(
      "Pi fragment returned 404: Session not found",
    );
  });
});
