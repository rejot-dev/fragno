import { describe, expect, test } from "vitest";

import { createPersistedToolCall, parsePersistedToolJournal } from "./tool-journal";

describe("parsePersistedToolJournal", () => {
  const createEntry = () =>
    createPersistedToolCall({
      sessionId: "session-1",
      turnId: "session-1:0",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "pwd" },
      result: {
        content: [{ type: "text", text: "ok" }],
        details: {},
      },
      isError: false,
      source: "executed",
      seq: 0,
    });

  test("rejects entries with a missing key and reports the field location", () => {
    const { key: _key, ...entry } = createEntry();

    expect(() => parsePersistedToolJournal({ toolJournal: [entry] }, "assistant-0")).toThrowError(
      /assistant-0\[0\]\.key/,
    );
  });

  test("rejects entries with an invalid seq and reports the field location", () => {
    const entry = {
      ...createEntry(),
      seq: "0",
    };

    expect(() => parsePersistedToolJournal({ toolJournal: [entry] }, "assistant-0")).toThrowError(
      /assistant-0\[0\]\.seq/,
    );
  });

  test("rejects entries with invalid result content and reports the nested field location", () => {
    const entry = {
      ...createEntry(),
      result: {
        content: ["ok"],
        details: {},
      },
    };

    expect(() => parsePersistedToolJournal({ toolJournal: [entry] }, "assistant-0")).toThrowError(
      /assistant-0\[0\]\.result\.content\.0/,
    );
  });
});
