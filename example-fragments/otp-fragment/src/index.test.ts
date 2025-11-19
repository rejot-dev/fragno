import { describe, test, expect, afterAll, assert, expectTypeOf } from "vitest";
import {
  otpFragmentDefinition,
  authFragmentDefinition,
  authFragmentRoutes,
  otpFragmentRoutes,
} from "./index";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import type { FragnoId } from "@fragno-dev/db/schema";

describe("OTP Fragment", () => {
  describe("Integration with UnitOfWork", async () => {
    const { fragments, test: testCtx } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("otp", instantiate(otpFragmentDefinition).withConfig({}).withRoutes([]))
      .build();

    afterAll(async () => {
      await testCtx.cleanup();
    });

    test("should work with multi-phase UOW pattern", async () => {
      const otpService = fragments.otp.services.otp;

      const code = await testCtx.inContext(async function () {
        return this.uow(async ({ executeMutate }) => {
          const code = otpService.generateOTP("user-123");

          await executeMutate();

          return code;
        });
      });

      expect(code).toMatch(/^\d{6}$/);

      // Verify OTP in a separate UOW context with automatic phase execution
      const isValid = await testCtx.inContext(async function () {
        return this.uow(async ({ executeMutate }) => {
          const isValidPromise = otpService.verifyOTP("user-123", code);
          await executeMutate();
          return isValidPromise;
        });
      });
      expect(isValid).toBe(true);
    });
  });
});

describe("Auth Fragment", () => {
  describe("random route", async () => {
    const { fragments, test: testCtx } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "auth",
        instantiate(authFragmentDefinition).withConfig({}).withRoutes(authFragmentRoutes),
      )
      .build();

    afterAll(async () => {
      await testCtx.cleanup();
    });

    test("retrieve random number", async () => {
      const response = await fragments.auth.callRoute("GET", "/random");
      assert(response.type === "json");
      expect(response.data).toMatchObject({
        random: expect.any(Number),
      });

      expect(response.data.random).toBeGreaterThan(0);
      expect(response.data.random).toBeLessThan(1000);
    });
  });
});

describe("OTP Fragment with Database (buildDatabaseFragmentsTest)", () => {
  describe("OTP Fragment - providesService", () => {
    test("should instantiate fragment that provides OTP service", async () => {
      const { test: testCtx } = await buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "kysely-sqlite" })
        .withFragment("otp", instantiate(otpFragmentDefinition).withConfig({}).withRoutes([]))
        .build();

      // Verify the fragment definition provides the service
      expect(otpFragmentDefinition.namedServices?.otp).toBeDefined();

      await testCtx.cleanup();
    });

    test("provided OTP service should be accessible", async () => {
      const { test: testCtx } = await buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "kysely-sqlite" })
        .withFragment("otp", instantiate(otpFragmentDefinition).withConfig({}).withRoutes([]))
        .build();

      await testCtx.cleanup();
    });
  });

  describe.sequential("Inter-Fragment Integration", async () => {
    const { test: testCtx, fragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "otp",
        instantiate(otpFragmentDefinition).withConfig({}).withRoutes(otpFragmentRoutes),
      )
      .withFragment(
        "auth",
        instantiate(authFragmentDefinition).withConfig({}).withRoutes(authFragmentRoutes),
      )
      .build();

    const otpFragment = fragments.otp;
    const authFragment = fragments.auth;

    let otpCode: string | null = null;
    let userId: string | null = null;

    afterAll(async () => {
      await testCtx.cleanup();
    });

    test("should create user with OTP", async () => {
      const response = await authFragment.callRoute("POST", "/auth/sign-up", {
        body: { email: "test@example.com", password: "password123" },
      });
      assert(response.type === "json");
      expect(response.data).toMatchObject({
        userId: expect.any(String),
        email: "test@example.com",
        emailVerified: false,
        otpCode: expect.stringMatching(/^\d{6}$/),
      });

      assert(response.data.otpCode);

      otpCode = response.data.otpCode;
      userId = response.data.userId;

      const otpCodes = await otpFragment.db.find("otp_code", (b) =>
        b.whereIndex("idx_otp_user", (eb) => eb("userId", "=", response.data.userId)).select(true),
      );
      expect(otpCodes).toHaveLength(1);
      const firstCode = otpCodes[0];

      expectTypeOf(firstCode).toMatchObjectType<{
        id: FragnoId;
        userId: string;
        code: string;
        expiresAt: Date;
        verified: boolean;
        createdAt: Date;
      }>();

      const user = await authFragment.db.findFirst("user", (b) =>
        b
          .whereIndex("idx_user_email", (eb) => eb("email", "=", "test@example.com"))
          .select(["id", "email", "emailVerified", "passwordHash"]),
      );
      expectTypeOf(user!).toMatchObjectType<{
        id: FragnoId;
        email: string;
        emailVerified: boolean;
        passwordHash: string;
      }>();

      expect(user?.id.externalId).toBe(response.data.userId);
      expect(user).toMatchObject({
        email: "test@example.com",
        emailVerified: false,
        passwordHash: "hashed_password123",
      });
    });

    test("should call the otp fragment route to verify the OTP", async () => {
      assert(userId);
      assert(otpCode);

      const response = await otpFragment.callRoute("POST", "/otp/verify", {
        body: { userId, code: otpCode },
      });

      assert(response.type === "json");
      expect(response.data).toMatchObject({ verified: true });
    });
  });
});
