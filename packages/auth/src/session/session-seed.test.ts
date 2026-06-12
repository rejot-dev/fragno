import { describe, expect, test, assert } from "vitest";

import { parseCredentialSeedFromQuery, serializeCredentialSeedForQuery } from "./session-seed";

describe("credential seed query parsing", () => {
  test("returns null when the query value is absent", () => {
    expect(parseCredentialSeedFromQuery(null)).toBeNull();
  });

  test("returns invalid when the query value is present but empty", () => {
    assert(parseCredentialSeedFromQuery("") === "invalid");
  });

  test("returns the parsed credential seed for valid query JSON", () => {
    const queryValue = serializeCredentialSeedForQuery({ activeOrganizationId: "org-1" });

    expect(parseCredentialSeedFromQuery(queryValue ?? null)).toEqual({
      activeOrganizationId: "org-1",
    });
  });

  test("returns invalid when query JSON cannot be parsed", () => {
    assert(parseCredentialSeedFromQuery("{not-json") === "invalid");
  });

  test("returns invalid when query JSON fails parseCredentialSeed validation", () => {
    assert(parseCredentialSeedFromQuery(JSON.stringify({})) === "invalid");
    assert(
      parseCredentialSeedFromQuery(JSON.stringify({ activeOrganizationId: "" })) === "invalid",
    );
  });
});
