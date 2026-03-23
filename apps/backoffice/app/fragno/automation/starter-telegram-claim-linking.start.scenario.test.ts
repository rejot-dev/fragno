import { describe, expect, test } from "vitest";

import { STARTER_AUTOMATION_SIMULATOR_PATHS, STARTER_FILE_MOUNT_POINT } from "@/files";

import {
  createDefaultAutomationFileSystem,
  defineAutomationScenario,
  runAutomationScenarioFile,
  simulateAutomationScenario,
} from "./index";
import { createTelegramMessageEvent } from "./scenario-test-utils";

describe("starter automation scenario: telegram-claim-linking.start.sh", () => {
  test("runs the starter claim-linking scenario file against the real workspace automation files", async () => {
    const fileSystem = await createDefaultAutomationFileSystem("org-1");

    const result = await runAutomationScenarioFile({
      fileSystem,
      path: `${STARTER_FILE_MOUNT_POINT}/${STARTER_AUTOMATION_SIMULATOR_PATHS.telegramClaimLinking}`,
    });

    expect(result.finalState.replies.map((reply) => reply.text)).toEqual([
      "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
      "Your Telegram chat is now linked.",
      "This Telegram chat is already linked.",
    ]);
    expect(result.transcript.steps[0]?.matchedBindingIds).toEqual([
      "telegram-claim-linking-start",
      "telegram-pi-session-ensure",
    ]);
    expect(result.transcript.steps[0]?.bindingRuns[0]?.commands[0]).toMatchObject({
      name: "automations.identity.lookup-binding",
      args: {
        source: "telegram",
        key: "chat-1",
      },
      exitCode: 1,
    });
  });

  test("creates a claim-link reply on /start when the Telegram chat is not linked", async () => {
    const fileSystem = await createDefaultAutomationFileSystem("org-1");

    const result = await simulateAutomationScenario({
      fileSystem,
      scenario: defineAutomationScenario({
        version: 1,
        name: "telegram-start-only",
        commandMocks: {
          "otp.identity.create-claim": {
            results: [
              {
                data: {
                  url: "https://example.com/claims/chat-1",
                  externalId: "chat-1",
                  code: "123456",
                  type: "otp",
                },
              },
            ],
            onExhausted: "default",
          },
        },
        steps: [
          {
            event: createTelegramMessageEvent(),
          },
        ],
      }),
    });

    expect(result.finalState.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalActorId: "chat-1",
          url: "https://example.com/claims/chat-1",
        }),
      ]),
    );
    expect(result.finalState.replies.map((reply) => reply.text)).toEqual([
      "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
    ]);
    expect(result.transcript.steps[0]?.bindingRuns[0]?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "otp.identity.create-claim",
          args: {
            source: "telegram",
            externalActorId: "chat-1",
          },
        }),
        expect.objectContaining({
          name: "event.reply",
          args: {
            text: "Open this link to finish linking your Telegram account: https://example.com/claims/chat-1",
          },
        }),
      ]),
    );
  });
});
