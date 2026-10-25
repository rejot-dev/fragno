// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";

import {
  getOrCreateWorkflowUiDraftEventId,
  workflowUiDrafts,
  type WorkflowUiDraft,
} from "./workflow-ui-drafts.client";

const STORAGE_KEY = "fragno-backoffice-workflow-ui-drafts";

const savedDraft: WorkflowUiDraft = {
  id: "run:step",
  state: { response: { reason: "Typed before" } },
  eventIds: { approval: "event-1" },
  submittedEventType: null,
  updatedAt: 1,
};

// What TanStack DB 0.15's localStorage collection stored for one draft.
const savedByTanStack = {
  "s:run:step": { versionKey: "7f1c1a52-6c8f-4d8a-9a43-1a6e4f0e1c11", data: savedDraft },
};

afterEach(() => localStorage.clear());

describe("workflow UI drafts", () => {
  test("load the drafts TanStack DB saved, and keep them when saving others", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedByTanStack));

    expect(workflowUiDrafts.get("run:step")).toEqual(savedDraft);

    await getOrCreateWorkflowUiDraftEventId({
      id: "run:other",
      eventType: "approval",
      initialState: {},
      fallbackEventId: "event-2",
    });
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, unknown>;
    expect(new Set(Object.keys(stored))).toEqual(new Set(["s:run:other", "s:run:step"]));
    expect(stored["s:run:step"]).toEqual(savedByTanStack["s:run:step"]);
    expect(workflowUiDrafts.get("run:other")?.eventIds).toEqual({ approval: "event-2" });
  });

  test.each([
    ["not JSON", "{", "Saved workflow input is not JSON."],
    ["not an object", "[]", "Saved workflow input is not an object of drafts."],
    [
      "an entry under a key that is not its ID",
      JSON.stringify({ "s:run:other": savedByTanStack["s:run:step"] }),
      "holds an entry that is not a draft: s:run:other.",
    ],
  ])("refuse storage that is %s, and leave it as it is", async (_kind, stored, message) => {
    localStorage.setItem(STORAGE_KEY, stored);

    expect(() => workflowUiDrafts.get("run:step")).toThrow(message);
    await expect(
      getOrCreateWorkflowUiDraftEventId({
        id: "run:step",
        eventType: "approval",
        initialState: {},
        fallbackEventId: "event-2",
      }),
    ).rejects.toThrow(message);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(stored);
  });
});
