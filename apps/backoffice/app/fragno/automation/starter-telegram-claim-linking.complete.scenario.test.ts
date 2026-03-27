import { describe, expect, test } from "vitest";

import {
  createMinimalFileSystem,
  defineAutomationScenario,
  simulateAutomationScenario,
} from "./index";
import { createOtpClaimCompletedEvent } from "./scenario-test-utils";

describe("starter automation scenario: telegram-claim-linking.complete.sh", () => {
  test("binds the Telegram actor and replies when OTP claim completion arrives", async () => {
    const fileSystem = await createMinimalFileSystem("org-1");

    const result = await simulateAutomationScenario({
      fileSystem,
      scenario: defineAutomationScenario({
        version: 1,
        name: "otp-complete-only",
        steps: [
          {
            event: createOtpClaimCompletedEvent(),
          },
        ],
      }),
    });

    expect(result.transcript.steps[0]?.matchedBindingIds).toEqual([
      "telegram-claim-linking-complete",
    ]);
    expect(result.finalState.identityBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "telegram",
          key: "chat-1",
          value: "user-1",
          status: "linked",
        }),
      ]),
    );
    expect(result.finalState.replies.map((reply) => reply.text)).toEqual([
      "Your Telegram chat is now linked.",
    ]);
    expect(result.transcript.steps[0]?.bindingRuns[0]?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "automations.identity.bind-actor",
          args: {
            source: "telegram",
            key: "chat-1",
            value: "user-1",
          },
        }),
        expect.objectContaining({
          name: "telegram.chat.send",
          args: {
            chatId: "chat-1",
            text: "Your Telegram chat is now linked.",
          },
        }),
      ]),
    );
  });

  test("records a failure transcript and fallback reply when the subject user is missing", async () => {
    const fileSystem = await createMinimalFileSystem("org-1");

    const result = await simulateAutomationScenario({
      fileSystem,
      scenario: defineAutomationScenario({
        version: 1,
        name: "otp-complete-missing-subject",
        steps: [
          {
            event: createOtpClaimCompletedEvent({
              id: "otp-event-missing-subject",
              subject: null,
            }),
          },
        ],
      }),
    });

    expect(result.transcript.steps[0]?.status).toBe("failed");
    expect(result.transcript.steps[0]?.bindingRuns[0]).toMatchObject({
      bindingId: "telegram-claim-linking-complete",
      exitCode: 1,
      stderr: expect.stringContaining("Missing subject.userId in event"),
    });
    expect(result.finalState.replies.map((reply) => reply.text)).toEqual([
      "We couldn't link your Telegram chat. Please try again.",
    ]);
    expect(result.finalState.identityBindings).toEqual([]);
  });
});
