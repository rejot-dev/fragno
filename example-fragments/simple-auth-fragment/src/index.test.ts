import { afterAll, assert, describe, expect, it } from "vitest";
import { authFragmentDefinition } from ".";
import { userActionsRoutesFactory } from "./user/user-actions";
import { sessionRoutesFactory } from "./session/session";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";

describe("simple-auth-fragment", async () => {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "auth",
      instantiate(authFragmentDefinition).withRoutes([
        userActionsRoutesFactory,
        sessionRoutesFactory,
      ]),
    )
    .build();

  const fragment = fragments.auth;

  afterAll(async () => {
    await test.cleanup();
  });

  describe("Full session flow", async () => {
    let sessionId: string;
    let userId: string;

    it("/sign-up - create user", async () => {
      const response = await fragment.callRoute("POST", "/sign-up", {
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
      const data = response.data;
      sessionId = data.sessionId;
      userId = data.userId;
    });

    it("/me - get active session", async () => {
      const response = await fragment.callRoute("GET", "/me", {
        query: { sessionId },
      });

      assert(response.type === "json");
      expect(response.data).toMatchObject({
        userId: userId,
        email: "test@test.com",
      });
    });

    it("/sign-out - invalidate session", async () => {
      const response = await fragment.callRoute("POST", "/sign-out", {
        body: { sessionId },
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({ success: true });
    });

    it("/me - get inactive session", async () => {
      const response = await fragment.callRoute("GET", "/me", {
        query: { sessionId },
      });

      assert(response.type === "error");
      expect(response.error.code).toBe("session_invalid");
    });

    it("/sign-in - invalid credentials", async () => {
      const response = await fragment.callRoute("POST", "/sign-in", {
        body: { email: "test@test.com", password: "wrongpassword" },
      });
      assert(response.type === "error");
      expect(response.error.code).toBe("invalid_credentials");
    });

    it("/sign-in - sign in user", async () => {
      const response = await fragment.callRoute("POST", "/sign-in", {
        body: { email: "test@test.com", password: "password" },
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({
        sessionId: expect.any(String),
        userId: expect.any(String),
        email: "test@test.com",
      });

      const data = response.data as { sessionId: string; userId: string; email: string };
      sessionId = data.sessionId;
      userId = data.userId;
    });
  });
});
