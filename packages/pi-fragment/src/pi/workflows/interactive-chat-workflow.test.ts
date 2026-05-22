import { describe, expect, it } from "vitest";

import { interactiveChatWorkflowParamsSchema } from "./interactive-chat-workflow";

describe("interactiveChatWorkflowParamsSchema", () => {
  it("rejects malformed initial messages", () => {
    expect(() =>
      interactiveChatWorkflowParamsSchema.parse({
        agentName: "default",
        initialMessages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).toThrow();
  });

  it("accepts valid initial messages", () => {
    expect(
      interactiveChatWorkflowParamsSchema.parse({
        agentName: "default",
        initialMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: 1,
          },
        ],
      }),
    ).toMatchObject({
      initialMessages: [{ role: "user", timestamp: 1 }],
    });
  });
});
