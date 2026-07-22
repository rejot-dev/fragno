import { describe, expect, it } from "vitest";

import {
  projectPiSessionListingRows,
  resolvePiSessionListingState,
  type PiSessionListingSnapshot,
} from "./session-listing";

const snapshot: PiSessionListingSnapshot = {
  sessions: [
    {
      id: "local-session",
      name: "Local session",
      agent: "default::openai::model",
      workflowName: "interactive-chat-workflow",
      createdAt: new Date("2026-07-22T10:00:00.000Z"),
      updatedAt: new Date("2026-07-22T10:00:00.000Z"),
    },
  ],
  workflowStatuses: { "local-session": "waiting" },
};

describe("projectPiSessionListingRows", () => {
  it("maps joined collection rows into the session listing", () => {
    const listing = projectPiSessionListingRows([
      {
        sessionId: "session-1",
        name: "Local session",
        agent: "default::openai::model",
        workflowName: "interactive-chat-workflow",
        createdAt: new Date("2026-07-22T11:00:00.000Z"),
        updatedAt: new Date("2026-07-22T11:05:00.000Z"),
        workflowStatus: "active",
      },
    ]);

    expect(listing.sessions).toEqual([
      {
        id: "session-1",
        name: "Local session",
        agent: "default::openai::model",
        workflowName: "interactive-chat-workflow",
        createdAt: new Date("2026-07-22T11:00:00.000Z"),
        updatedAt: new Date("2026-07-22T11:05:00.000Z"),
      },
    ]);
    expect(listing.workflowStatuses).toEqual({ "session-1": "active" });
  });

  it("does not expose missing or unknown workflow statuses as Pi statuses", () => {
    const listing = projectPiSessionListingRows([
      {
        sessionId: "missing-workflow",
        name: null,
        agent: "default::openai::model",
        workflowName: "interactive-chat-workflow",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        workflowStatus: undefined,
      },
      {
        sessionId: "future-workflow",
        name: null,
        agent: "default::openai::model",
        workflowName: "interactive-chat-workflow",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        workflowStatus: "future-status",
      },
    ]);

    expect(listing.workflowStatuses).toEqual({
      "missing-workflow": null,
      "future-workflow": null,
    });
  });
});

describe("resolvePiSessionListingState", () => {
  it("marks the local snapshot as synchronizing until the query is ready", () => {
    expect(
      resolvePiSessionListingState({
        snapshot,
        synchronized: false,
        error: null,
      }),
    ).toEqual({ status: "synchronizing", snapshot });
  });

  it("marks the local snapshot as ready after synchronization", () => {
    expect(
      resolvePiSessionListingState({
        snapshot,
        synchronized: true,
        error: null,
      }),
    ).toEqual({ status: "ready", snapshot });
  });

  it("retains the local snapshot when synchronization fails", () => {
    expect(
      resolvePiSessionListingState({
        snapshot,
        synchronized: false,
        error: "stream unavailable",
      }),
    ).toEqual({
      status: "error",
      snapshot,
      error: "stream unavailable",
    });
  });
});
