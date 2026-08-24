import { describe, expect, test, assert } from "vitest";

import {
  BACKOFFICE_HOME_PATH,
  BACKOFFICE_LOGIN_PATH,
  buildBackofficeLoginPath,
  buildBackofficeOrganizationSwitchPath,
  buildBackofficeSignUpPath,
  readBackofficeOrganizationSwitchId,
  readBackofficeReturnTo,
  retargetBackofficeOrganizationReturnTo,
  sanitizeBackofficeReturnTo,
} from "./auth-navigation";

describe("sanitizeBackofficeReturnTo", () => {
  test("trims values, preserves query strings, and strips hashes for backoffice paths", () => {
    assert(
      sanitizeBackofficeReturnTo(" /backoffice/settings?tab=members#security ") ===
        "/backoffice/settings?tab=members",
    );
  });

  test("normalizes login paths and query variants back to the backoffice home", () => {
    expect(sanitizeBackofficeReturnTo(BACKOFFICE_LOGIN_PATH)).toBe(BACKOFFICE_HOME_PATH);
    expect(sanitizeBackofficeReturnTo("/backoffice/login?next=ignored#hash")).toBe(
      BACKOFFICE_HOME_PATH,
    );
  });

  test("allows org-scoped MCP OAuth callback paths so login can resume OAuth", () => {
    assert(
      sanitizeBackofficeReturnTo(
        "/api/mcp/org%3Aorg_123/oauth/callback?code=abc&state=cloudflare%3Astate#ignored",
      ) === "/api/mcp/org%3Aorg_123/oauth/callback?code=abc&state=cloudflare%3Astate",
    );
  });

  test("rejects paths outside the backoffice namespace or allowed callback routes", () => {
    expect(sanitizeBackofficeReturnTo("/docs")).toBeNull();
    expect(sanitizeBackofficeReturnTo("/backoffice-login")).toBeNull();
    expect(sanitizeBackofficeReturnTo("/backoffice/../docs")).toBeNull();
    expect(sanitizeBackofficeReturnTo("/api/mcp/org%3Aorg_123/servers")).toBeNull();
    expect(sanitizeBackofficeReturnTo("/api/mcp/org%3Aorg_123/oauth/callback/extra")).toBeNull();
    expect(sanitizeBackofficeReturnTo("/api/mcp/org%3Aorg_123/oauth/authorize")).toBeNull();
  });
});

describe("backoffice auth navigation helpers", () => {
  test("builds login paths with a cleaned returnTo only", () => {
    assert(
      buildBackofficeLoginPath("/backoffice/settings?tab=members#security") ===
        "/backoffice/login?returnTo=%2Fbackoffice%2Fsettings%3Ftab%3Dmembers",
    );
    assert(
      buildBackofficeLoginPath(
        "/api/mcp/org%3Aorg_123/oauth/callback?code=abc&state=cloudflare%3As",
      ) ===
        "/backoffice/login?returnTo=%2Fapi%2Fmcp%2Forg%253Aorg_123%2Foauth%2Fcallback%3Fcode%3Dabc%26state%3Dcloudflare%253As",
    );
    expect(
      buildBackofficeLoginPath(
        "/api/mcp/org%3Aorg_123/oauth/authorize?authorizationUrl=https%3A%2F%2Fmoneybird.com%2Foauth%2Fauthorize",
      ),
    ).toBe(BACKOFFICE_LOGIN_PATH);
    expect(buildBackofficeLoginPath("/backoffice/login?x=1")).toBe(BACKOFFICE_LOGIN_PATH);
  });

  test("preserves invitation return paths when moving from login to sign-up", () => {
    const returnTo =
      "/backoffice/invitations/AYFpGE1yoCO3H2epFjXSVOdk2tjn4UNt?token=AYFpGE1yoCO3H2epFjXSVOdk2tjn4UNt";
    const signUpPath = buildBackofficeSignUpPath(returnTo);

    assert(readBackofficeReturnTo(signUpPath) === returnTo);
  });

  test("builds organization switch paths with an explicit destination", () => {
    const switchPath = buildBackofficeOrganizationSwitchPath(
      "org-2",
      "/backoffice/automations/org/org-2/dashboard",
    );
    expect(switchPath).toBe(
      "/backoffice/auth/bootstrap?organizationId=org-2&returnTo=%2Fbackoffice%2Fautomations%2Forg%2Forg-2%2Fdashboard",
    );
    assert(readBackofficeOrganizationSwitchId(switchPath) === "org-2");
  });

  test("retargets an organization-scoped destination after changing identity", () => {
    assert(
      retargetBackofficeOrganizationReturnTo(
        "/backoffice/automations/org/org-stale/dashboard?scriptView=code",
        "org-current",
      ) === "/backoffice/automations/org/org-current/dashboard?scriptView=code",
    );
  });

  test("preserves unscoped invitation destinations after changing identity", () => {
    const invitation = "/backoffice/invitations/invite-1?token=secret";
    expect(retargetBackofficeOrganizationReturnTo(invitation, "org-current")).toBe(invitation);
  });

  test("reads the returnTo value with the same sanitization", () => {
    assert(
      readBackofficeReturnTo(
        "http://localhost/backoffice/login?returnTo=%2Fbackoffice%2Fsettings%3Ftab%3Dmembers",
      ) === "/backoffice/settings?tab=members",
    );
    assert(
      readBackofficeReturnTo(
        "http://localhost/backoffice/login?returnTo=%2Fapi%2Fmcp%2Forg%253Aorg_123%2Foauth%2Fcallback%3Fcode%3Dabc%26state%3Dcloudflare%253As",
      ) === "/api/mcp/org%3Aorg_123/oauth/callback?code=abc&state=cloudflare%3As",
    );
    expect(
      readBackofficeReturnTo(
        "http://localhost/backoffice/login?returnTo=%2Fapi%2Fmcp%2Forg%253Aorg_123%2Foauth%2Fauthorize%3FauthorizationUrl%3Dhttps%253A%252F%252Fmoneybird.com%252Foauth%252Fauthorize",
      ),
    ).toBe(BACKOFFICE_HOME_PATH);
    expect(
      readBackofficeReturnTo("http://localhost/backoffice/login?returnTo=%2Fbackoffice-login"),
    ).toBe(BACKOFFICE_HOME_PATH);
  });
});
