import { describe, expect, test, vi } from "vitest";

import {
  createTrustedSystemBackofficeToolContext,
  type BackofficeToolContext,
} from "../runtime-tools";
import { piRuntimeTools, type PiRuntime } from "./pi";

const createRuntime = (): PiRuntime =>
  ({
    createSession: vi.fn(async ({ model, name }) => ({
      id: "session-1",
      name: name ?? null,
      status: "waiting",
      metadata: { model },
      workflowName: "interactive-chat-workflow",
      createdAt: new Date("2026-06-03T00:00:00.000Z"),
      updatedAt: new Date("2026-06-03T00:00:00.000Z"),
    })),
    getSession: vi.fn(async ({ sessionId }) => createSessionDetail(sessionId)),
    listSessions: vi.fn(async () => [
      {
        id: "session-1",
        name: null,
        status: "waiting",
        metadata: { model: { provider: "openai", name: "gpt-5.6-luna" } },
        workflowName: "interactive-chat-workflow",
        createdAt: new Date("2026-06-03T00:00:00.000Z"),
        updatedAt: new Date("2026-06-03T00:00:00.000Z"),
      },
    ]),
    runTurn: vi.fn(async ({ sessionId, text }) => ({
      ...createSessionDetail(sessionId),
      assistantText: `echo: ${text}`,
      commandStatus: "waiting",
      stream: [],
      terminalState: { messages: [] },
    })),
  }) as unknown as PiRuntime;

const createSessionDetail = (sessionId: string) => ({
  id: sessionId,
  name: null,
  workflowName: "interactive-chat-workflow",
  createdAt: new Date("2026-06-03T00:00:00.000Z"),
  updatedAt: new Date("2026-06-03T00:00:00.000Z"),
  metadata: { model: { provider: "openai", name: "gpt-5.6-luna" } },
  workflow: { status: "waiting" },
  agent: { state: { messages: [] } },
});

describe("pi runtime tools", () => {
  test("defines camelCase codemode names and legacy bash commands", () => {
    expect(piRuntimeTools.map((tool) => [tool.name, tool.adapters?.bash?.command])).toEqual([
      ["createSession", "pi.session.create"],
      ["getSession", "pi.session.get"],
      ["listSessions", "pi.session.list"],
      ["runTurn", "pi.session.turn"],
    ]);
  });

  test("parse and validate session create input", () => {
    const [createSession] = piRuntimeTools;

    expect(
      createSession.inputSchema.parse(
        createSession.adapters!.bash!.parse([
          "--model-json",
          '{"provider":"openai","name":"gpt-5.6-luna"}',
          "--name",
          "support",
          "--tag",
          "urgent",
          "--tag",
          "customer",
          "--metadata-json",
          '{"ticket":"123"}',
          "--steering-mode",
          "one-at-a-time",
        ]),
      ),
    ).toEqual({
      model: { provider: "openai", name: "gpt-5.6-luna" },
      name: "support",
      metadata: { ticket: "123" },
      tags: ["urgent", "customer"],
      steeringMode: "one-at-a-time",
    });
  });

  test("accepts serialized runtime dates and exposes ISO date strings", async () => {
    const [createSession] = piRuntimeTools;
    const runtime = {
      createSession: vi.fn(async ({ model, name }) => ({
        id: "session-1",
        name: name ?? null,
        status: "waiting",
        metadata: { model },
        workflowName: "interactive-chat-workflow",
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: new Date("2026-06-03T00:01:00.000Z"),
      })),
    } as unknown as PiRuntime;
    const context: BackofficeToolContext<{ pi: PiRuntime }> =
      createTrustedSystemBackofficeToolContext({
        runtimes: { pi: runtime },
      });

    await expect(
      createSession.execute(
        { model: { provider: "openai", name: "gpt-5.6-luna" }, name: "Support" },
        context,
      ),
    ).resolves.toEqual({
      id: "session-1",
      name: "Support",
      status: "waiting",
      metadata: { model: { provider: "openai", name: "gpt-5.6-luna" } },
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:01:00.000Z",
    });
  });

  test("parse boolean session get flags", () => {
    const getSession = piRuntimeTools[1];

    expect(
      getSession.inputSchema.parse(
        getSession.adapters!.bash!.parse([
          "--session-id",
          "session-1",
          "--events",
          "--trace",
          "false",
          "--turns",
          "true",
        ]),
      ),
    ).toEqual({ sessionId: "session-1", events: true, trace: false, turns: true });
  });

  test("accepts session create responses without a legacy top-level status", async () => {
    const createSession = piRuntimeTools[0];
    const runtime = {
      createSession: vi.fn(async ({ model, name }) => ({
        id: "session-1",
        name: name ?? null,
        metadata: { model },
        workflowName: "interactive-chat-workflow",
        createdAt: new Date("2026-06-03T00:00:00.000Z"),
        updatedAt: new Date("2026-06-03T00:00:00.000Z"),
      })),
    } as unknown as PiRuntime;
    const context: BackofficeToolContext<{ pi: PiRuntime }> =
      createTrustedSystemBackofficeToolContext({
        runtimes: { pi: runtime },
      });

    await expect(
      createSession.execute(
        { model: { provider: "openai", name: "gpt-5.6-luna" }, name: "Support" },
        context,
      ),
    ).resolves.toMatchObject({
      id: "session-1",
      metadata: { model: { provider: "openai", name: "gpt-5.6-luna" } },
      name: "Support",
    });
    expect(runtime.createSession).toHaveBeenCalledWith({
      model: { provider: "openai", name: "gpt-5.6-luna" },
      name: "Support",
    });
  });

  test("accepts current Pi session detail contract", async () => {
    const getSession = piRuntimeTools[1];
    const runtime = createRuntime();
    const context: BackofficeToolContext<{ pi: PiRuntime }> =
      createTrustedSystemBackofficeToolContext({
        runtimes: { pi: runtime },
      });

    await expect(getSession.execute({ sessionId: "session-1" }, context)).resolves.toMatchObject({
      agent: { state: { messages: [] } },
    });
    expect(runtime.getSession).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  test("invokes semantic runtime for codemode", async () => {
    const runtime = createRuntime();
    const context: BackofficeToolContext<{ pi: PiRuntime }> =
      createTrustedSystemBackofficeToolContext({
        runtimes: { pi: runtime },
      });

    await expect(
      piRuntimeTools[3].execute({ sessionId: "session-1", text: "Hello" }, context),
    ).resolves.toMatchObject({
      agent: { state: { messages: [] } },
      assistantText: "echo: Hello",
    });
    expect(runtime.runTurn).toHaveBeenCalledWith({ sessionId: "session-1", text: "Hello" });
  });
});
