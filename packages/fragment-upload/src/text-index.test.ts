import { describe, expect, it } from "vitest";

import {
  MAX_SEARCH_CONTEXT_LINE_LENGTH,
  MAX_SEARCH_LINE_TEXT_LENGTH,
  searchTextContent,
} from "./text-index";

describe("searchTextContent", () => {
  it("resumes directly from a character offset", () => {
    const text = "needle needle needle needle";

    expect(
      searchTextContent("repeated.txt", text, "needle", {
        startOffset: 14,
        maxMatches: 2,
      }).map((match) => match.startOffset),
    ).toEqual([14, 21]);
  });

  it("returns no matches at or beyond the end of the content", () => {
    const text = "needle";

    expect(searchTextContent("end.txt", text, "needle", { startOffset: text.length })).toEqual([]);
    expect(searchTextContent("past-end.txt", text, "needle", { startOffset: 10_000 })).toEqual([]);
  });

  it("applies whole-word and case rules after resuming", () => {
    const text = "Needlework NEEDLE needle";

    expect(
      searchTextContent("words.txt", text, "needle", {
        caseSensitive: false,
        wholeWord: true,
        startOffset: 1,
      }).map((match) => match.startOffset),
    ).toEqual([11, 18]);
  });

  it("can resume after a dense prefix without returning earlier matches", () => {
    const prefix = "needle ".repeat(100_000);
    const text = `${prefix}tail needle`;

    expect(
      searchTextContent("dense.txt", text, "needle", {
        startOffset: prefix.length,
        maxMatches: 1,
      }).map((match) => match.startOffset),
    ).toEqual([prefix.length + "tail ".length]);
  });

  it("bounds source lines while retaining the matching text", () => {
    const longPrefix = "a".repeat(10_000);
    const longSuffix = "b".repeat(10_000);
    const longContext = "c".repeat(10_000);
    const matches = searchTextContent(
      "large.txt",
      `${longContext}\n${longPrefix}needle${longSuffix}\n${longContext}`,
      "needle",
      { contextBefore: 1, contextAfter: 1 },
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.lineText).toContain("needle");
    expect(matches[0]?.lineText.length).toBeLessThanOrEqual(MAX_SEARCH_LINE_TEXT_LENGTH);
    expect(matches[0]?.contextBefore[0]?.length).toBeLessThanOrEqual(
      MAX_SEARCH_CONTEXT_LINE_LENGTH,
    );
    expect(matches[0]?.contextAfter[0]?.length).toBeLessThanOrEqual(MAX_SEARCH_CONTEXT_LINE_LENGTH);
  });
});
