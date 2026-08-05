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
      metadata: { model: { provider: "openai", name: "model" } },
      workflowName: "interactive-chat-workflow",
      createdAt: new Date("2026-07-22T10:00:00.000Z"),
      updatedAt: new Date("2026-07-22T10:00:00.000Z"),
    },
  ],
  workflowStatuses: { "local-session": "waiting" },
};

describe("projectPiSessionListingRows", () => {
  it("maps workflow instance rows into the session listing", () => {
    const listing = projectPiSessionListingRows([
      {
        sessionId: "session-1",
        workflowName: "interactive-chat-workflow",
        params: {
          metadata: { model: { provider: "openai", name: "model" } },
          __piSession: {
            name: "Local session",
          },
        },
        createdAt: new Date("2026-07-22T11:00:00.000Z"),
        updatedAt: new Date("2026-07-22T11:05:00.000Z"),
        workflowStatus: "active",
      },
    ]);

    expect(listing.sessions).toEqual([
      {
        id: "session-1",
        name: "Local session",
        metadata: { model: { provider: "openai", name: "model" } },
        workflowName: "interactive-chat-workflow",
        createdAt: new Date("2026-07-22T11:00:00.000Z"),
        updatedAt: new Date("2026-07-22T11:05:00.000Z"),
      },
    ]);
    expect(listing.workflowStatuses).toEqual({ "session-1": "active" });
  });

  it("omits workflow instances without Pi session data", () => {
    const listing = projectPiSessionListingRows([
      {
        sessionId: "future-workflow",
        workflowName: "interactive-chat-workflow",
        params: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
        workflowStatus: "future-status",
      },
    ]);

    expect(listing.sessions).toEqual([]);
    expect(listing.workflowStatuses).toEqual({});
  });

  it("does not expose unknown workflow statuses as Pi statuses", () => {
    const listing = projectPiSessionListingRows([
      {
        sessionId: "future-workflow",
        workflowName: "interactive-chat-workflow",
        params: {
          metadata: { model: { provider: "openai", name: "model" } },
          __piSession: {
            name: null,
          },
        },
        createdAt: new Date(0),
        updatedAt: new Date(0),
        workflowStatus: "future-status",
      },
    ]);

    expect(listing.workflowStatuses).toEqual({ "future-workflow": null });
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
