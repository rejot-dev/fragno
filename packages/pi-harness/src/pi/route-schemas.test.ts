import { assert, describe, test } from "vitest";

import { commandInputSchema, piSessionCommandPayloadSchema } from "./route-schemas";

describe("piSessionCommandPayloadSchema", () => {
  test("accepts raw base64 image data", () => {
    assert(
      piSessionCommandPayloadSchema.safeParse({
        commandId: "command-1",
        kind: "prompt",
        input: {
          text: "describe this image",
          images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        },
      }).success,
    );
  });

  test("rejects nextTurn as a session command", () => {
    assert(
      !commandInputSchema.safeParse({
        kind: "nextTurn",
        input: { text: "continue" },
      }).success,
    );
    assert(
      !piSessionCommandPayloadSchema.safeParse({
        commandId: "command-1",
        kind: "nextTurn",
        input: { text: "continue" },
      }).success,
    );
  });

  test.each(["", "not base64!", "data:image/png;base64,aGVsbG8="])(
    "rejects non-raw base64 image data: %s",
    (data) => {
      assert(
        !piSessionCommandPayloadSchema.safeParse({
          commandId: "command-1",
          kind: "prompt",
          input: {
            text: "describe this image",
            images: [{ type: "image", data, mimeType: "image/png" }],
          },
        }).success,
      );
    },
  );
});
