import { describe, expect, test } from "vitest";

import { listAutomationEventDescriptors } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

describe("telegram automation event catalog", () => {
  test("describes normalized attachment payloads", () => {
    const descriptor = listAutomationEventDescriptors().find(
      (event) => event.source === "telegram" && event.eventType === "message.received",
    );

    expect(descriptor?.payloadSchema).toMatchObject({
      type: "object",
      properties: {
        attachments: {
          type: "array",
          items: {
            oneOf: expect.arrayContaining([
              expect.objectContaining({
                properties: expect.objectContaining({
                  kind: { type: "string", const: "voice" },
                  fileId: { type: "string" },
                  fileUniqueId: { type: "string" },
                  duration: expect.objectContaining({ type: "integer" }),
                  mimeType: { type: "string" },
                }),
                required: expect.arrayContaining(["kind", "fileId", "fileUniqueId", "duration"]),
              }),
            ]),
          },
        },
      },
    });
    expect(descriptor?.example).toMatchObject({
      attachments: [{ kind: "voice", fileId: "voice-file-1" }],
    });
  });
});
