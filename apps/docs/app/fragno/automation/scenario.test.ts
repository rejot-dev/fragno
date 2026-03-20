import { describe, expect, test } from "vitest";

import { defineAutomationScenario, simulateAutomationScenario } from "./index";
import {
  STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH,
  buildManifest,
  createAutomationFileSystem,
  createTelegramMessageEvent,
} from "./scenario-test-utils";

describe("automation scenario simulator", () => {
  test("sorts matching bindings by trigger order and binding id while skipping disabled bindings", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: buildManifest([
        {
          id: "beta",
          triggerOrder: 10,
          enabled: true,
          script: {
            key: "beta",
            name: "Beta",
            path: "scripts/beta.sh",
          },
        },
        {
          id: "disabled",
          triggerOrder: 1,
          enabled: false,
          script: {
            key: "disabled",
            name: "Disabled",
            path: "scripts/disabled.sh",
          },
        },
        {
          id: "alpha",
          triggerOrder: 10,
          enabled: true,
          script: {
            key: "alpha",
            name: "Alpha",
            path: "scripts/alpha.sh",
          },
        },
      ]),
      "automations/scripts/alpha.sh": 'event.reply --text "from-alpha"',
      "automations/scripts/beta.sh": 'event.reply --text "from-beta"',
      "automations/scripts/disabled.sh": 'event.reply --text "should-not-run"',
    });

    const result = await simulateAutomationScenario({
      fileSystem,
      scenario: defineAutomationScenario({
        version: 1,
        name: "ordering",
        steps: [
          {
            event: createTelegramMessageEvent({
              id: "ordering-1",
            }),
          },
        ],
      }),
    });

    expect(result.transcript.steps[0]?.matchedBindingIds).toEqual(["alpha", "beta"]);
    expect(result.finalState.replies.map((reply) => reply.text)).toEqual([
      "from-alpha",
      "from-beta",
    ]);
  });

  test("stops after the first failing binding and records a failure transcript", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: buildManifest([
        {
          id: "failing",
          triggerOrder: 1,
          enabled: true,
          script: {
            key: "failing",
            name: "Failing",
            path: "scripts/failing.sh",
          },
        },
        {
          id: "later",
          triggerOrder: 2,
          enabled: true,
          script: {
            key: "later",
            name: "Later",
            path: "scripts/later.sh",
          },
        },
      ]),
      "automations/scripts/failing.sh": ['echo "boom" >&2', "exit 9"].join("\n"),
      "automations/scripts/later.sh": 'event.reply --text "should-not-run"',
    });

    const result = await simulateAutomationScenario({
      fileSystem,
      scenario: defineAutomationScenario({
        version: 1,
        name: "failure",
        steps: [
          {
            event: createTelegramMessageEvent({
              id: "failure-1",
              payload: {
                text: "/start",
              },
            }),
          },
        ],
      }),
    });

    expect(result.transcript.steps[0]?.status).toBe("failed");
    expect(result.transcript.steps[0]?.bindingRuns).toHaveLength(1);
    expect(result.transcript.steps[0]?.bindingRuns[0]).toMatchObject({
      bindingId: "failing",
      exitCode: 9,
      stderr: expect.stringContaining("boom"),
    });
    expect(result.transcript.steps[0]?.failure?.message).toContain(
      "Automation bash script script:failing@1:scripts/failing.sh failed for event failure-1 with exit code 9.",
    );
    expect(result.finalState.replies).toEqual([]);
  });

  test("synthesizes pi.session.turn results and persists the updated Pi session state", async () => {
    const fileSystem = await createAutomationFileSystem({
      [STARTER_AUTOMATION_MANIFEST_RELATIVE_PATH]: buildManifest([
        {
          id: "pi-turn",
          enabled: true,
          script: {
            key: "pi-turn",
            name: "Pi turn",
            path: "scripts/pi-turn.sh",
          },
        },
      ]),
      "automations/scripts/pi-turn.sh": [
        'assistant_text="$(pi.session.turn --session-id session-1 --text "$AUTOMATION_TELEGRAM_TEXT" --print assistantText)"',
        'event.reply --text "$assistant_text"',
      ].join("\n"),
    });

    const result = await simulateAutomationScenario({
      fileSystem,
      scenario: defineAutomationScenario({
        version: 1,
        name: "pi-turn",
        initialState: {
          piSessions: [
            {
              id: "session-1",
              agent: "assistant",
              name: "Support",
              status: "waiting",
              steeringMode: "one-at-a-time",
              metadata: null,
              tags: ["telegram"],
              workflow: {
                status: "waiting",
              },
              messages: [],
              summaries: [],
              turn: 0,
              phase: "waiting-for-user",
              waitingFor: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        steps: [
          {
            event: createTelegramMessageEvent({
              id: "pi-turn-1",
              payload: {
                text: "hello from telegram",
                chatId: "chat-1",
              },
            }),
          },
        ],
      }),
    });

    expect(result.finalState.replies.map((reply) => reply.text)).toEqual([
      "Simulated assistant reply to: hello from telegram",
    ]);
    expect(result.finalState.piSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session-1",
          workflow: expect.objectContaining({
            status: "waiting",
          }),
          assistantText: "Simulated assistant reply to: hello from telegram",
        }),
      ]),
    );
    expect(result.transcript.steps[0]?.bindingRuns[0]?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "pi.session.turn",
          args: expect.objectContaining({
            sessionId: "session-1",
            text: "hello from telegram",
          }),
          stdout: "Simulated assistant reply to: hello from telegram\n",
        }),
      ]),
    );
  });
});
