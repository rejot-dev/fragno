import { assert, describe, expect, it } from "vitest";

import {
  applyFileEditOperation,
  diffContent,
  replaceTextContent,
  stringifyJsonFileContent,
} from "./file-edits";

describe("file edits", () => {
  it("replaces literal text case-sensitively by default", () => {
    expect(replaceTextContent("Enabled enabled", "enabled", "disabled")).toEqual({
      content: "Enabled disabled",
      replaced: 1,
    });
  });

  it("supports insensitive whole-word replacement and a match limit", () => {
    expect(
      replaceTextContent("cat scatter CAT cat", "cat", "$1", {
        caseSensitive: false,
        wholeWord: true,
        maxMatches: 2,
      }),
    ).toEqual({ content: "$1 scatter $1 cat", replaced: 2 });
  });

  it("treats replacement text literally for regular expressions", () => {
    expect(replaceTextContent("a1 a2", "a\\d", "$&", { regex: true })).toEqual({
      content: "$& $&",
      replaced: 2,
    });
  });

  it("rejects empty and invalid search patterns", () => {
    expect(() => replaceTextContent("text", "", "next")).toThrow("Search query must not be empty");
    expect(() => replaceTextContent("text", "[", "next", { regex: true })).toThrow(
      "Invalid search pattern",
    );
  });

  it("formats JSON with a trailing newline", () => {
    assert(
      stringifyJsonFileContent({ enabled: true }, "config.json") === '{\n  "enabled": true\n}\n',
    );
    expect(() => stringifyJsonFileContent(undefined, "config.json")).toThrow(
      "Unable to serialize JSON",
    );
  });

  it("applies sequential operation semantics", () => {
    const written = applyFileEditOperation(null, {
      kind: "write",
      fileKey: "file.txt",
      content: "before",
    });
    assert(
      applyFileEditOperation(written, {
        kind: "replace",
        fileKey: "file.txt",
        search: "before",
        replacement: "after",
      }) === "after",
    );
  });

  it("creates a focused unified diff and returns no diff for unchanged content", () => {
    assert(diffContent("same", "same", "a/file", "b/file") === "");
    expect(diffContent("one\ntwo\nthree", "one\nchanged\nthree", "a/file", "b/file")).toContain(
      "-two\n+changed",
    );
  });

  it("bounds diff input by line count", () => {
    const tooManyLines = Array.from({ length: 10_001 }, () => "line").join("\n");
    expect(() => diffContent(tooManyLines, "next", "a/file", "b/file")).toThrow(
      "too large for a diff",
    );
  });
});
