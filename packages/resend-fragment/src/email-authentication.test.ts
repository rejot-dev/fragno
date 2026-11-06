import { describe, expect, test } from "vitest";

import { readEmailAuthentication } from "./email-authentication";

describe("readEmailAuthentication", () => {
  test("reads Resend's results", () => {
    expect(readEmailAuthentication({ spf: "fail", dkim: "pass", dmarc: "gray" })).toEqual({
      spf: "fail",
      dkim: "pass",
      dmarc: "gray",
    });
  });

  test("is null when Resend reported none", () => {
    expect(readEmailAuthentication(undefined)).toBeNull();
    expect(readEmailAuthentication(null)).toBeNull();
    expect(readEmailAuthentication("pass")).toBeNull();
  });

  test("reads a missing or unrecognised result as unknown, never as a pass", () => {
    expect(readEmailAuthentication({ spf: "softfail", dkim: true })).toEqual({
      spf: "unknown",
      dkim: "unknown",
      dmarc: "unknown",
    });
  });
});
