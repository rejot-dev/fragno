import { describe, expect, test } from "vitest";

import { parseCredentialSeedFromQuery, serializeCredentialSeedForQuery } from "./session-seed";

describe("credential seed query parsing", () => {
  test("returns null when the query value is absent", () => {
    expect(parseCredentialSeedFromQuery(null)).toBeNull();
  });

  test("returns invalid when the query value is present but empty", () => {
    expect(parseCredentialSeedFromQuery("")).toBe("invalid");
  });

  test("returns the parsed credential seed for valid query JSON", () => {
    const queryValue = serializeCredentialSeedForQuery({ activeOrganizationId: "org-1" });

    expect(parseCredentialSeedFromQuery(queryValue ?? null)).toEqual({
      activeOrganizationId: "org-1",
    });
  });

  test("returns invalid when query JSON cannot be parsed", () => {
    expect(parseCredentialSeedFromQuery("{not-json")).toBe("invalid");
  });

  test("returns invalid when query JSON fails parseCredentialSeed validation", () => {
    expect(parseCredentialSeedFromQuery(JSON.stringify({}))).toBe("invalid");
    expect(parseCredentialSeedFromQuery(JSON.stringify({ activeOrganizationId: "" }))).toBe(
      "invalid",
    );
  });
});
