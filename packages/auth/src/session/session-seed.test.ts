import { describe, expect, test } from "vitest";
import { parseSessionSeedFromQuery, serializeSessionSeedForQuery } from "./session-seed";

describe("session seed query parsing", () => {
  test("returns null when the query value is absent", () => {
    expect(parseSessionSeedFromQuery(null)).toBeNull();
  });

  test("returns invalid when the query value is present but empty", () => {
    expect(parseSessionSeedFromQuery("")).toBe("invalid");
  });

  test("returns the parsed session seed for valid query JSON", () => {
    const queryValue = serializeSessionSeedForQuery({ activeOrganizationId: "org-1" });

    expect(parseSessionSeedFromQuery(queryValue ?? null)).toEqual({
      activeOrganizationId: "org-1",
    });
  });

  test("returns invalid when query JSON cannot be parsed", () => {
    expect(parseSessionSeedFromQuery("{not-json")).toBe("invalid");
  });

  test("returns invalid when query JSON fails parseSessionSeed validation", () => {
    expect(parseSessionSeedFromQuery(JSON.stringify({}))).toBe("invalid");
    expect(parseSessionSeedFromQuery(JSON.stringify({ activeOrganizationId: "" }))).toBe("invalid");
  });
});
