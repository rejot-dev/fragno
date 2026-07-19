import { describe, expect, it, assert } from "vitest";

import { decodeFileKey, encodeFileKey, encodeFileKeyPrefix, type FileKeyParts } from "./keys";

describe("file key encoding", () => {
  it("round-trips strings and numbers", () => {
    const parts: FileKeyParts = ["users", 42, "avatar", 3, ""];
    const encoded = encodeFileKey(parts);
    expect(encoded).toMatch(/^[A-Za-z0-9_.~-]+$/);
    expect(decodeFileKey(encoded)).toEqual(parts);
  });

  it("encodes prefixes safely", () => {
    const prefix = encodeFileKeyPrefix(["users", 1]);
    assert(prefix.endsWith("."));
    expect(prefix).toBe(`${encodeFileKey(["users", 1])}.`);
  });

  it("returns an empty prefix for empty input", () => {
    assert(encodeFileKeyPrefix([]) === "");
    assert(encodeFileKey([]) === "");
    expect(decodeFileKey("")).toEqual([]);
  });

  it("rejects invalid parts", () => {
    expect(() => encodeFileKey([Number.NaN])).toThrow("File key number parts must be finite");
    expect(() => encodeFileKey([3.5])).toThrow("File key number parts must be integers");
  });

  it("rejects invalid segments", () => {
    expect(() => decodeFileKey("x~abc")).toThrow("Invalid file key segment");
    expect(() => decodeFileKey("n~01")).toThrow("Invalid number part");
    expect(() => decodeFileKey("s~++")).toThrow("Invalid base64url value");
  });
});
