import { afterAll, assert, describe, expect, it } from "vitest";
import { authFragmentDefinition, authRoutesFactory } from ".";
import { createDatabaseFragmentForTest } from "@fragno-dev/test";

describe("simple-auth-fragment", async () => {
  const { fragment, test } = await createDatabaseFragmentForTest(authFragmentDefinition, {
    adapter: { type: "drizzle-pglite" },
  });

  afterAll(async () => {
    await test.cleanup();
  });

  describe("Full session flow", async () => {
    const routes = [authRoutesFactory] as const;
    const [signUpRoute, signInRoute, signOutRoute, meRoute] = fragment.initRoutes(routes);

    let sessionId: string;
    let userId: string;

    it("/sign-up - create user", async () => {
      const response = await fragment.handler(signUpRoute, {
        body: {
          email: "test@test.com",
          password: "password",
        },
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({
        sessionId: expect.any(String),
        userId: expect.any(String),
        email: "test@test.com",
      });
      sessionId = response.data.sessionId;
      userId = response.data.userId;
    });

    it("/me - get active session", async () => {
      const response = await fragment.handler(meRoute, {
        query: { sessionId },
      });

      assert(response.type === "json");
      expect(response.data).toMatchObject({
        userId: userId,
        email: "test@test.com",
      });
    });

    it("/sign-out - invalidate session", async () => {
      const response = await fragment.handler(signOutRoute, {
        body: { sessionId },
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({ success: true });
    });

    it("/me - get inactive session", async () => {
      const response = await fragment.handler(meRoute, {
        query: { sessionId },
      });

      assert(response.type === "error");
      expect(response.error.code).toBe("session_invalid");
    });

    it("/sign-in - invalid credentials", async () => {
      const response = await fragment.handler(signInRoute, {
        body: { email: "test@test.com", password: "wrongpassword" },
      });
      assert(response.type === "error");
      expect(response.error.code).toBe("invalid_credentials");
    });

    it("/sign-in - sign in user", async () => {
      const response = await fragment.handler(signInRoute, {
        body: { email: "test@test.com", password: "password" },
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({
        sessionId: expect.any(String),
        userId: expect.any(String),
        email: "test@test.com",
      });

      sessionId = response.data.sessionId;
      userId = response.data.userId;
    });
  });
});
