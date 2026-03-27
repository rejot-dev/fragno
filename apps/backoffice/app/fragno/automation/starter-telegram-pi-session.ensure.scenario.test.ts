import { describe, expect, test } from "vitest";

import { STARTER_AUTOMATION_SIMULATOR_PATHS, STARTER_FILE_MOUNT_POINT } from "@/files";

import { createMinimalFileSystem, runAutomationScenarioFile } from "./index";

describe("starter automation scenario: telegram-pi-session.ensure.sh", () => {
  test("runs the starter Telegram Pi scenario file, bootstraps a session, and keeps later messages in the original Pi conversation", async () => {
    const fileSystem = await createMinimalFileSystem("org-1");

    const result = await runAutomationScenarioFile({
      fileSystem,
      path: `${STARTER_FILE_MOUNT_POINT}/${STARTER_AUTOMATION_SIMULATOR_PATHS.telegramPiSession}`,
    });

    expect(result.finalState.replies.map((reply) => reply.text)).toEqual([
      "Created Pi session: session-for-default::openai::gpt-5-mini",
      "Pi says hello from the linked Telegram session.",
      "Pi continues the original conversation.",
    ]);
    expect(result.finalState.piSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session-for-default::openai::gpt-5-mini",
          agent: "default::openai::gpt-5-mini",
          workflow: expect.objectContaining({
            status: "waiting",
          }),
          assistantText: "Pi continues the original conversation.",
        }),
      ]),
    );
    expect(result.finalState.identityBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "telegram-pi-session",
          key: "user-1",
          value: "session-for-default::openai::gpt-5-mini",
        }),
      ]),
    );
    expect(result.transcript.steps[0]?.bindingRuns[1]?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "pi.session.create",
          args: expect.objectContaining({
            agent: "default::openai::gpt-5-mini",
            name: "Telegram chat-1",
            tags: ["telegram", "auto-session"],
          }),
        }),
      ]),
    );
    expect(result.transcript.steps[1]?.bindingRuns[1]?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "pi.session.turn",
          args: expect.objectContaining({
            sessionId: "session-for-default::openai::gpt-5-mini",
            text: "Hello Pi",
          }),
        }),
      ]),
    );
    expect(result.transcript.steps[2]?.bindingRuns[1]?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "pi.session.turn",
          args: expect.objectContaining({
            sessionId: "session-for-default::openai::gpt-5-mini",
            text: "And one more thing",
          }),
        }),
      ]),
    );

    const allCommands = result.transcript.steps.flatMap((step) =>
      step.bindingRuns.flatMap((run) => run.commands),
    );
    expect(allCommands.filter((command) => command.name === "pi.session.create")).toHaveLength(1);
    expect(allCommands.filter((command) => command.name === "pi.session.turn")).toHaveLength(2);
  });
});
