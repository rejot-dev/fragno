import { assert, describe, expect, test } from "vitest";

import { backofficeRouteScopeSinglePathSegmentFromParams } from "@/backoffice-runtime/route-scope";

import {
  API_PUBLIC_PREFIX,
  apiPublicAddress,
  apiWebhookPublicUrl,
  isScopedPublicOAuthRedirectUriAllowed,
  scopedPublicMountPath,
} from "./scoped-public-fragment-routes";

describe("scoped public fragment routes", () => {
  test.each([
    [{ kind: "system" as const }, "/api/pi/system"],
    [{ kind: "org" as const, orgId: "org:one" }, "/api/pi/org%3Aorg%253Aone"],
    [{ kind: "user" as const, userId: "user/one" }, "/api/pi/user%3Auser%252Fone"],
    [
      { kind: "project" as const, orgId: "org:one", projectId: "project/two" },
      "/api/pi/project%3Aorg%253Aone%3Aproject%252Ftwo",
    ],
  ])("builds a mount path for the %s scope", (scope, expected) => {
    expect(scopedPublicMountPath({ publicPrefix: "/api/pi", scope })).toBe(expected);
  });

  test("builds API OAuth and webhook URLs from a slug-backed scope segment", () => {
    const address = apiPublicAddress("https://backoffice.example", "org:acme");

    expect(address).toEqual({
      baseUrl: "https://backoffice.example/api/http/org%3Aacme",
      oauthRedirectUri: "https://backoffice.example/api/http/org%3Aacme/oauth/callback",
    });
    assert.equal(
      apiWebhookPublicUrl(address.baseUrl, "stripe/events"),
      "https://backoffice.example/api/http/org%3Aacme/webhooks/endpoints/stripe%2Fevents/events",
    );
  });

  test("builds project API addresses from decoded router parameters", () => {
    const scopePathSegment = backofficeRouteScopeSinglePathSegmentFromParams({
      scopeKind: "project",
      scopeId: "acme:project%2Fone",
    });

    expect(apiPublicAddress("https://backoffice.example", scopePathSegment)).toEqual({
      baseUrl: "https://backoffice.example/api/http/project%3Aacme%3Aproject%252Fone",
      oauthRedirectUri:
        "https://backoffice.example/api/http/project%3Aacme%3Aproject%252Fone/oauth/callback",
    });
  });

  test("allows only scoped API OAuth callbacks on the configured public origin", () => {
    const redirectUri = new URL(
      apiPublicAddress("https://backoffice.example", "org:acme").oauthRedirectUri,
    );

    assert(
      isScopedPublicOAuthRedirectUriAllowed({
        publicOrigin: "https://backoffice.example",
        publicPrefix: API_PUBLIC_PREFIX,
        redirectUri,
      }),
    );
    assert(
      !isScopedPublicOAuthRedirectUriAllowed({
        publicOrigin: "https://backoffice.example",
        publicPrefix: API_PUBLIC_PREFIX,
        redirectUri: new URL("https://attacker.example/api/http/org%3Aacme/oauth/callback"),
      }),
    );
    assert(
      !isScopedPublicOAuthRedirectUriAllowed({
        publicOrigin: "https://backoffice.example",
        publicPrefix: API_PUBLIC_PREFIX,
        redirectUri: new URL(
          "https://backoffice.example/api/http/org%3Aacme/oauth/callback?next=attacker",
        ),
      }),
    );
  });

  test.each([undefined, "ftp://backoffice.example", "not a URL"])(
    "rejects invalid API public origin %s",
    (publicOrigin) => {
      expect(() => apiPublicAddress(publicOrigin, "org:acme")).toThrow(
        /API public origin (is not configured|must be a valid HTTP or HTTPS URL)/,
      );
    },
  );
});
