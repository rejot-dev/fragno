import { describe, expect, test } from "vitest";

import {
  BACKOFFICE_HOME_PATH,
  BACKOFFICE_LOGIN_PATH,
  buildBackofficeLoginPath,
  readBackofficeReturnTo,
  sanitizeBackofficeReturnTo,
} from "./auth-navigation";

describe("sanitizeBackofficeReturnTo", () => {
  test("trims values and strips query strings and hashes for backoffice paths", () => {
    expect(sanitizeBackofficeReturnTo(" /backoffice/settings?tab=members#security ")).toBe(
      "/backoffice/settings",
    );
  });

  test("normalizes login paths and query variants back to the backoffice home", () => {
    expect(sanitizeBackofficeReturnTo(BACKOFFICE_LOGIN_PATH)).toBe(BACKOFFICE_HOME_PATH);
    expect(sanitizeBackofficeReturnTo("/backoffice/login?next=ignored#hash")).toBe(
      BACKOFFICE_HOME_PATH,
    );
  });

  test("rejects paths outside the backoffice namespace or that escape it after parsing", () => {
    expect(sanitizeBackofficeReturnTo("/docs")).toBeNull();
    expect(sanitizeBackofficeReturnTo("/backoffice-login")).toBeNull();
    expect(sanitizeBackofficeReturnTo("/backoffice/../docs")).toBeNull();
  });
});

describe("backoffice auth navigation helpers", () => {
  test("builds login paths with a cleaned backoffice returnTo only", () => {
    expect(buildBackofficeLoginPath("/backoffice/settings?tab=members#security")).toBe(
      "/backoffice/login?returnTo=%2Fbackoffice%2Fsettings",
    );
    expect(buildBackofficeLoginPath("/backoffice/login?x=1")).toBe(BACKOFFICE_LOGIN_PATH);
  });

  test("reads the returnTo value with the same backoffice-only sanitization", () => {
    expect(
      readBackofficeReturnTo(
        "http://localhost/backoffice/login?returnTo=%2Fbackoffice%2Fsettings%3Ftab%3Dmembers",
      ),
    ).toBe("/backoffice/settings");
    expect(
      readBackofficeReturnTo("http://localhost/backoffice/login?returnTo=%2Fbackoffice-login"),
    ).toBe(BACKOFFICE_HOME_PATH);
  });
});
