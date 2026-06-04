import { describe, expect, test, vi } from "vitest";

import type { BackofficeToolContext } from "../runtime-tools";
import { piRuntimeTools, type PiRuntime } from "./pi";

const createRuntime = (): PiRuntime =>
  ({
    createSession: vi.fn(async ({ agent, name }) => ({ id: "session-1", agent, name })),
    getSession: vi.fn(async ({ sessionId }) => ({ id: sessionId })),
    listSessions: vi.fn(async () => [{ id: "session-1" }]),
    runTurn: vi.fn(async ({ sessionId, text }) => ({
      id: sessionId,
      assistantText: `echo: ${text}`,
      messageStatus: "idle",
      stream: [],
      terminalState: {},
    })),
  }) as unknown as PiRuntime;

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
          "--agent",
          "assistant",
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
      agent: "assistant",
      name: "support",
      metadata: { ticket: "123" },
      tags: ["urgent", "customer"],
      steeringMode: "one-at-a-time",
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

  test("invokes semantic runtime for codemode", async () => {
    const runtime = createRuntime();
    const context: BackofficeToolContext<{ pi: PiRuntime }> = { runtimes: { pi: runtime } };

    await expect(
      piRuntimeTools[3].execute({ sessionId: "session-1", text: "Hello" }, context),
    ).resolves.toMatchObject({
      assistantText: "echo: Hello",
    });
    expect(runtime.runTurn).toHaveBeenCalledWith({ sessionId: "session-1", text: "Hello" });
  });
});
