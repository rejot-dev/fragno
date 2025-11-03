import { describe, test, expect, afterAll, assert } from "vitest";
import {
  otpFragmentDefinition,
  authFragmentDefinition,
  authFragmentRoutes,
  otpFragmentRoutes,
} from "./index";
import { createDatabaseFragmentForTest, createDatabaseFragmentsForTest } from "@fragno-dev/test";

describe("OTP Fragment", () => {
  describe("Integration with UnitOfWork", async () => {
    const result = await createDatabaseFragmentForTest(
      { definition: otpFragmentDefinition, routes: [] },
      {
        adapter: { type: "kysely-sqlite" },
      },
    );

    afterAll(async () => {
      await result.test.cleanup();
    });

    test("should work with multi-phase UOW pattern", async () => {
      const otpService = result.fragment.services.otp;

      const code = await result.test.withUnitOfWork(async (uow) => {
        const code = otpService.generateOTP("user-123");
        expect(code).toMatch(/^\d{6}$/);

        await uow.executeRetrieve();
        await uow.executeMutations();

        // Verify we have a mutation operation
        expect(uow.getMutationOperations()).toHaveLength(1);

        return code;
      });

      // Verify OTP in a separate UOW context with automatic phase execution
      const isValid = await result.test.callService(() => otpService.verifyOTP("user-123", code));
      expect(isValid).toBe(true);
    });
  });
});

describe("Auth Fragment", () => {
  describe("random route", async () => {
    const result = await createDatabaseFragmentForTest(
      { definition: authFragmentDefinition, routes: authFragmentRoutes },
      {
        adapter: { type: "kysely-sqlite" },
      },
    );

    afterAll(async () => {
      await result.test.cleanup();
    });

    test("retrieve random number", async () => {
      const response = await result.fragment.callRoute("GET", "/random");
      assert(response.type === "json");
      expect(response.data).toMatchObject({
        random: expect.any(Number),
      });

      expect(response.data.random).toBeGreaterThan(0);
      expect(response.data.random).toBeLessThan(1000);
    });
  });
});

describe("OTP Fragment with Database (createDatabaseFragmentForTest)", () => {
  describe("OTP Fragment - providesService", () => {
    test("should instantiate fragment that provides OTP service", async () => {
      const fragment = await createDatabaseFragmentForTest(
        { definition: otpFragmentDefinition, routes: [] },
        {
          adapter: { type: "kysely-sqlite" },
        },
      );

      // Verify the fragment definition provides the service
      expect(otpFragmentDefinition.definition.providedServices).toBeDefined();
      expect(otpFragmentDefinition.definition.providedServices?.otp).toBeDefined();

      await fragment.test.cleanup();
    });

    test("provided OTP service should be accessible", async () => {
      const { test } = await createDatabaseFragmentForTest(
        { definition: otpFragmentDefinition, routes: [] },
        {
          adapter: { type: "kysely-sqlite" },
        },
      );

      const providedService = otpFragmentDefinition.definition.providedServices?.otp;
      expect(providedService).toBeDefined();
      expect(typeof providedService?.generateOTP).toBe("function");
      expect(typeof providedService?.verifyOTP).toBe("function");

      await test.cleanup();
    });
  });

  describe.sequential("Inter-Fragment Integration", async () => {
    const { test: testCtx, fragments } = await createDatabaseFragmentsForTest(
      [
        { definition: otpFragmentDefinition, routes: otpFragmentRoutes },
        { definition: authFragmentDefinition, routes: authFragmentRoutes },
      ],
      { adapter: { type: "kysely-sqlite" } },
    );

    const [otpFragment, authFragment] = fragments;

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
        b.whereIndex("idx_otp_user", (eb) => eb("userId", "=", response.data.userId)),
      );
      expect(otpCodes).toHaveLength(1);

      const user = await authFragment.db.findFirst("user", (b) =>
        b.whereIndex("idx_user_email", (eb) => eb("email", "=", "test@example.com")),
      );
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
