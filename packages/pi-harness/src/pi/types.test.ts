import { describe, expect, it } from "vitest";

import { PiSessionDataIntegrityError, projectPiSessionFromWorkflowInstance } from "./types";

const instance = {
  id: "session-1",
  workflowName: "interactive-chat-workflow",
  createdAt: new Date("2026-08-02T09:00:00.000Z"),
  updatedAt: new Date("2026-08-02T09:01:00.000Z"),
};

describe("projectPiSessionFromWorkflowInstance", () => {
  it("projects persisted Pi session values", () => {
    expect(
      projectPiSessionFromWorkflowInstance({
        ...instance,
        params: {
          metadata: { runtime: "persisted-runtime" },
          __piSession: { name: "My session" },
        },
      }),
    ).toEqual({
      ...instance,
      name: "My session",
      metadata: { runtime: "persisted-runtime" },
    });
  });

  it("throws a data-integrity error when the Pi session marker is malformed", () => {
    expect(() =>
      projectPiSessionFromWorkflowInstance({
        ...instance,
        params: {
          metadata: { runtime: "persisted-runtime" },
          __piSession: { name: 42 },
        },
      }),
    ).toThrow(PiSessionDataIntegrityError);
  });

  it("throws a data-integrity error when persisted session metadata is malformed", () => {
    expect(() =>
      projectPiSessionFromWorkflowInstance({
        ...instance,
        params: {
          metadata: "persisted-runtime",
          __piSession: { name: "My session" },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PI_SESSION_DATA_INTEGRITY_ERROR",
        workflowName: instance.workflowName,
        sessionId: instance.id,
      }),
    );
  });

  it("returns null when Pi session data is absent", () => {
    expect(
      projectPiSessionFromWorkflowInstance({
        ...instance,
        params: { metadata: { runtime: "persisted-runtime" } },
      }),
    ).toBeNull();
  });
});
