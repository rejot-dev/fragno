import { describe, test, assert } from "vitest";

import { formatTimestampInTimeZone } from "./formatting";

describe("automation timestamp formatting", () => {
  test("formats schedule occurrences in the configured IANA time zone", () => {
    assert(
      formatTimestampInTimeZone("2026-07-16T11:03:00.000Z", "Europe/Amsterdam") ===
        "Jul 16, 2026, 13:03 Europe/Amsterdam",
    );
  });
});
