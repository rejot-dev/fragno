import { afterAll, beforeEach, describe, expect, it, vi, assert } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { otpFragmentDefinition } from "./definition";
import { otpRoutes } from "./index";

const isDbNowMarker = (value: unknown): value is { tag: "db-now"; offsetMs?: number } => {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag" in value &&
    (value as { tag?: unknown }).tag === "db-now"
  );
};

const expectOtpTimestamp = (value: unknown) => {
  expect(value instanceof Date || isDbNowMarker(value)).toBe(true);
};

describe("otp fragment", async () => {
  const onOtpIssued = vi.fn();
  const onOtpConfirmed = vi.fn();
  const onOtpExpired = vi.fn();

  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "otp",
      instantiate(otpFragmentDefinition)
        .withConfig({
          hooks: {
            onOtpIssued,
            onOtpConfirmed,
            onOtpExpired,
          },
        })
        .withRoutes(otpRoutes),
    )
    .build();

  beforeEach(async () => {
    await test.resetDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await test.cleanup();
  });

  it("fails during fragment setup when OTP code config is invalid", async () => {
    await expect(
      buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "kysely-sqlite" })
        .withFragment(
          "otp",
          instantiate(otpFragmentDefinition)
            .withConfig({
              alphabet: "",
            })
            .withRoutes(otpRoutes),
        )
        .build(),
    ).rejects.toThrow("OTP alphabet must not be empty.");

    await expect(
      buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "kysely-sqlite" })
        .withFragment(
          "otp",
          instantiate(otpFragmentDefinition)
            .withConfig({
              codeLength: 0,
            })
            .withRoutes(otpRoutes),
        )
        .build(),
    ).rejects.toThrow("OTP codeLength must be a positive integer.");
  });

  it("issues an OTP and invalidates earlier pending OTPs for the same user and type", async () => {
    const firstResponse = await fragments.otp.callRoute("POST", "/otp/issue", {
      body: { userId: "user-1", type: "email_verification" },
    });
    assert(firstResponse.type === "json");

    const secondResponse = await fragments.otp.callRoute("POST", "/otp/issue", {
      body: { userId: "user-1", type: "email_verification" },
    });
    assert(secondResponse.type === "json");

    expect(firstResponse.data.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(secondResponse.data.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(secondResponse.data.code).not.toBe(firstResponse.data.code);
    expectOtpTimestamp(firstResponse.data.createdAt);
    expectOtpTimestamp(firstResponse.data.expiresAt);
    expectOtpTimestamp(secondResponse.data.createdAt);
    expectOtpTimestamp(secondResponse.data.expiresAt);

    const otpRows = await fragments.otp.db.find("otp", (b) =>
      b.whereIndex("idx_otp_user_type_createdAt", (eb) =>
        eb.and(eb("userId", "=", "user-1"), eb("type", "=", "email_verification")),
      ),
    );

    expect(otpRows).toHaveLength(2);
    expect(otpRows.filter((otp) => otp.status === "pending")).toHaveLength(1);
    expect(otpRows.filter((otp) => otp.status === "invalidated")).toHaveLength(1);
  });

  it("confirms an OTP, returns database-time markers immediately, and resolves hook dates", async () => {
    const issueResponse = await fragments.otp.callRoute("POST", "/otp/issue", {
      body: { userId: "user-2", type: "password_reset" },
    });
    assert(issueResponse.type === "json");

    const confirmResponse = await fragments.otp.callRoute("POST", "/otp/confirm", {
      body: {
        userId: "user-2",
        type: "password_reset",
        code: issueResponse.data.code.toLowerCase(),
      },
    });
    assert(confirmResponse.type === "json");

    expect(confirmResponse.data.confirmed).toBe(true);
    expectOtpTimestamp(confirmResponse.data.confirmedAt);

    await drainDurableHooks(fragments.otp.fragment);

    expect(onOtpIssued).toHaveBeenCalledTimes(1);
    expect(onOtpIssued).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-2",
        type: "password_reset",
        code: issueResponse.data.code,
        createdAt: expect.any(Date),
        expiresAt: expect.any(Date),
      }),
      expect.any(String),
    );

    expect(onOtpConfirmed).toHaveBeenCalledTimes(1);
    expect(onOtpConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-2",
        type: "password_reset",
        code: issueResponse.data.code,
        createdAt: expect.any(Date),
        expiresAt: expect.any(Date),
        confirmedAt: expect.any(Date),
      }),
      expect.any(String),
    );

    const storedOtp = await fragments.otp.db.findFirst("otp", (b) =>
      b.whereIndex("primary", (eb) => eb("id", "=", issueResponse.data.id)),
    );
    expect(storedOtp?.status).toBe("confirmed");
    expect(storedOtp?.confirmedAt).toBeInstanceOf(Date);
  });

  it("returns OTP_EXPIRED for expired OTPs and resolves expiry hook dates", async () => {
    const { test: expiringTest, fragments: expiringFragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "otp",
        instantiate(otpFragmentDefinition)
          .withConfig({
            defaultExpiryMinutes: 0,
            hooks: {
              onOtpExpired,
            },
          })
          .withRoutes(otpRoutes),
      )
      .build();

    try {
      const issueResponse = await expiringFragments.otp.callRoute("POST", "/otp/issue", {
        body: { userId: "user-3", type: "passwordless_login" },
      });
      assert(issueResponse.type === "json");

      const confirmResponse = await expiringFragments.otp.callRoute("POST", "/otp/confirm", {
        body: {
          userId: "user-3",
          type: "passwordless_login",
          code: issueResponse.data.code,
        },
      });
      assert(confirmResponse.type === "error");
      expect(confirmResponse.status).toBe(410);
      expect(confirmResponse.error.code).toBe("OTP_EXPIRED");

      await drainDurableHooks(expiringFragments.otp.fragment);

      expect(onOtpExpired).toHaveBeenCalledTimes(1);
      expect(onOtpExpired).toHaveBeenCalledWith(
        expect.objectContaining({
          id: issueResponse.data.id,
          userId: "user-3",
          type: "passwordless_login",
          code: issueResponse.data.code,
          createdAt: expect.any(Date),
          expiresAt: expect.any(Date),
          expiredAt: expect.any(Date),
        }),
        expect.any(String),
      );

      const storedOtp = await expiringFragments.otp.db.findFirst("otp", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", issueResponse.data.id)),
      );
      expect(storedOtp?.status).toBe("expired");
      expect(storedOtp?.expiredAt).toBeInstanceOf(Date);
    } finally {
      await expiringTest.cleanup();
    }
  });

  it("confirms lowercase OTPs exactly when a custom lowercase alphabet is configured", async () => {
    const { test: lowercaseTest, fragments: lowercaseFragments } =
      await buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "drizzle-pglite" })
        .withFragment(
          "otp",
          instantiate(otpFragmentDefinition)
            .withConfig({
              alphabet: "abcdef123",
              codeLength: 6,
            })
            .withRoutes(otpRoutes),
        )
        .build();

    try {
      const issueResponse = await lowercaseFragments.otp.callRoute("POST", "/otp/issue", {
        body: { userId: "user-5", type: "email_verification" },
      });
      assert(issueResponse.type === "json");
      expect(issueResponse.data.code).toMatch(/^[abcdef123]{6}$/);

      const confirmResponse = await lowercaseFragments.otp.callRoute("POST", "/otp/confirm", {
        body: {
          userId: "user-5",
          type: "email_verification",
          code: issueResponse.data.code,
        },
      });
      assert(confirmResponse.type === "json");
      expect(confirmResponse.data.confirmed).toBe(true);
      expectOtpTimestamp(confirmResponse.data.confirmedAt);
    } finally {
      await lowercaseTest.cleanup();
    }
  });

  it("persists expiry immediately when confirmation observes an expired OTP", async () => {
    const { test: expiringTest, fragments: expiringFragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "drizzle-pglite" })
      .withFragment(
        "otp",
        instantiate(otpFragmentDefinition)
          .withConfig({
            defaultExpiryMinutes: 0,
            hooks: {
              onOtpExpired,
            },
          })
          .withRoutes(otpRoutes),
      )
      .build();

    try {
      const issueResponse = await expiringFragments.otp.callRoute("POST", "/otp/issue", {
        body: { userId: "user-6", type: "password_reset" },
      });
      assert(issueResponse.type === "json");

      const confirmResponse = await expiringFragments.otp.callRoute("POST", "/otp/confirm", {
        body: {
          userId: "user-6",
          type: "password_reset",
          code: issueResponse.data.code,
        },
      });
      assert(confirmResponse.type === "error");
      expect(confirmResponse.status).toBe(410);
      expect(confirmResponse.error.code).toBe("OTP_EXPIRED");

      const storedAfterConfirm = await expiringFragments.otp.db.findFirst("otp", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", issueResponse.data.id)),
      );
      expect(storedAfterConfirm?.status).toBe("expired");
      expect(storedAfterConfirm?.expiredAt).toBeInstanceOf(Date);
      expect(storedAfterConfirm?.invalidatedAt).toBeNull();

      const invalidateResponse = await expiringFragments.otp.callRoute("POST", "/otp/invalidate", {
        body: {
          userId: "user-6",
          type: "password_reset",
        },
      });
      assert(invalidateResponse.type === "json");
      expect(invalidateResponse.data.invalidatedCount).toBe(0);

      await drainDurableHooks(expiringFragments.otp.fragment);

      expect(onOtpExpired).toHaveBeenCalledWith(
        expect.objectContaining({
          id: issueResponse.data.id,
          userId: "user-6",
          type: "password_reset",
          code: issueResponse.data.code,
          expiredAt: expect.any(Date),
        }),
        expect.any(String),
      );

      const storedAfterHooks = await expiringFragments.otp.db.findFirst("otp", (b) =>
        b.whereIndex("primary", (eb) => eb("id", "=", issueResponse.data.id)),
      );
      expect(storedAfterHooks?.status).toBe("expired");
      expect(storedAfterHooks?.invalidatedAt).toBeNull();
    } finally {
      await expiringTest.cleanup();
    }
  });

  it("invalidates pending OTPs without confirming them", async () => {
    const issueResponse = await fragments.otp.callRoute("POST", "/otp/issue", {
      body: { userId: "user-4", type: "email_verification" },
    });
    assert(issueResponse.type === "json");

    const invalidateResponse = await fragments.otp.callRoute("POST", "/otp/invalidate", {
      body: { userId: "user-4", type: "email_verification" },
    });
    assert(invalidateResponse.type === "json");
    expect(invalidateResponse.data).toEqual({ invalidatedCount: 1 });

    const confirmResponse = await fragments.otp.callRoute("POST", "/otp/confirm", {
      body: {
        userId: "user-4",
        type: "email_verification",
        code: issueResponse.data.code,
      },
    });
    assert(confirmResponse.type === "error");
    expect(confirmResponse.status).toBe(401);
    expect(confirmResponse.error.code).toBe("OTP_INVALID");
  });
});
