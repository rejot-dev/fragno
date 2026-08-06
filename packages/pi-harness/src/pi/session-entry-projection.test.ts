import { describe, expect, it } from "vitest";

import { asPersistedPiHarnessStepResult } from "./session-entry-projection";

const timestamp = "2026-08-06T12:00:00.000Z";

describe("asPersistedPiHarnessStepResult", () => {
  it("returns the internally authored harness result without reparsing it", () => {
    const result = {
      type: "harness-run" as const,
      appendedEntries: [
        {
          type: "message" as const,
          id: "entry-1",
          parentId: null,
          timestamp,
          message: { role: "user" as const, content: "Hello", timestamp: 1 },
        },
      ],
      leafId: "entry-1",
      value: { ok: true },
    };

    expect(asPersistedPiHarnessStepResult(result)).toBe(result);
  });

  it("ignores results owned by other workflow steps", () => {
    expect(asPersistedPiHarnessStepResult({ type: "wait-for-event", payload: {} })).toBeNull();
    expect(asPersistedPiHarnessStepResult(null)).toBeNull();
  });
});
