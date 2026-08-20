import { describe, expect, test } from "vitest";

import { resolveLiveAccessTokenSecret } from "./contracts";

function authEnvironment(secret?: string): CloudflareEnv {
  return { AUTH_ACCESS_TOKEN_SECRET: secret } as CloudflareEnv;
}

describe("Backoffice authentication configuration", () => {
  test("rejects a short configured access-token secret", () => {
    expect(() => resolveLiveAccessTokenSecret(authEnvironment("too-short"), false)).toThrow(
      "AUTH_ACCESS_TOKEN_SECRET must contain at least 32 characters.",
    );
  });

  test("accepts a production access-token secret with at least 32 characters", () => {
    const secret = "a-production-secret-with-32-chars";

    expect(resolveLiveAccessTokenSecret(authEnvironment(secret), false)).toBe(secret);
  });

  test("requires explicit production configuration", () => {
    expect(() => resolveLiveAccessTokenSecret(authEnvironment(), false)).toThrow(
      "AUTH_ACCESS_TOKEN_SECRET must be configured for backoffice auth.",
    );
  });

  test("provides the development fallback only in development", () => {
    expect(resolveLiveAccessTokenSecret(authEnvironment(), true)).toHaveLength(
      "fragno-backoffice-development-access-token-secret".length,
    );
  });
});
