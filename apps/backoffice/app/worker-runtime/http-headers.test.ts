import { describe, expect, it } from "vitest";

import { getSetCookieHeaders } from "./http-headers";

describe("getSetCookieHeaders", () => {
  it("uses the runtime multi-cookie API when available", () => {
    const headers = {
      getSetCookie: () => ["first=1; Path=/", "second=2; Path=/"],
      get: () => "combined-cookie-header",
    } as unknown as Headers;

    expect(getSetCookieHeaders(headers)).toEqual(["first=1; Path=/", "second=2; Path=/"]);
  });

  it("falls back to a single Set-Cookie header", () => {
    const headers = {
      get: (name: string) => (name.toLowerCase() === "set-cookie" ? "first=1; Path=/" : null),
    } as unknown as Headers;

    expect(getSetCookieHeaders(headers)).toEqual(["first=1; Path=/"]);
  });

  it("returns an empty list when no cookies were set", () => {
    const headers = { get: () => null } as unknown as Headers;
    expect(getSetCookieHeaders(headers)).toEqual([]);
  });
});
