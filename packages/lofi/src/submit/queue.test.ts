import { describe, expect, it } from "vitest";

import superjson from "superjson";

import { loadSubmitQueue } from "./queue";

describe("loadSubmitQueue", () => {
  it("throws when persisted queue JSON is invalid", async () => {
    await expect(
      loadSubmitQueue(
        {
          getMeta: async () => "not-json",
        },
        "app::submit-queue",
      ),
    ).rejects.toThrow("Failed to decode persisted Lofi meta value for app::submit-queue");
  });

  it("throws when persisted queue entries are malformed", async () => {
    await expect(
      loadSubmitQueue(
        {
          getMeta: async () =>
            JSON.stringify(
              superjson.serialize([{ id: 123, name: "noop", target: { fragment: "app" } }]),
            ),
        },
        "app::submit-queue",
      ),
    ).rejects.toThrow("Submit queue entry at index 0 is missing a valid id");
  });
});
