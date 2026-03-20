import { describe, expect, test } from "vitest";

import { STARTER_AUTOMATION_SIMULATOR_PATHS, STARTER_FILE_MOUNT_POINT } from "@/files";

import { createDefaultAutomationFileSystem, runAutomationScenarioFile } from "./index";

describe("starter automation scenario: telegram-pi-session.ensure.sh", () => {
  test("runs the starter /pi scenario file and persists the mocked Pi session state", async () => {
    const fileSystem = await createDefaultAutomationFileSystem("org-1");

    const result = await runAutomationScenarioFile({
      fileSystem,
      path: `${STARTER_FILE_MOUNT_POINT}/${STARTER_AUTOMATION_SIMULATOR_PATHS.telegramPiSession}`,
    });

    expect(result.finalState.replies.map((reply) => reply.text)).toEqual([
      "Created Pi session: session-for-default::openai::gpt-5-mini",
    ]);
    expect(result.finalState.piSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session-for-default::openai::gpt-5-mini",
          agent: "default::openai::gpt-5-mini",
          workflow: expect.objectContaining({
            status: "waiting",
          }),
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
  });
});
