import { afterAll, beforeEach, describe, expect, it, vi, assert } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { MAX_OTP_REQUEST_ID_LENGTH, otpFragmentDefinition } from "./definition";
import { OtpIssueError, type OtpIssueErrorCode } from "./errors";
import { otpRoutes } from "./index";
import { otpSchema } from "./schema";

const expectOtpIssueError = async (
  promise: Promise<unknown>,
  code: OtpIssueErrorCode,
): Promise<void> => {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );

  assert(error instanceof OtpIssueError);
  expect(error.code).toBe(code);
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
      body: { externalId: "user-1", type: "email_verification" },
    });
    assert(firstResponse.type === "json");

    const secondResponse = await fragments.otp.callRoute("POST", "/otp/issue", {
      body: { externalId: "user-1", type: "email_verification" },
    });
    assert(secondResponse.type === "json");

    assert(firstResponse.data.status === "pending");
    assert(secondResponse.data.status === "pending");
    expect(firstResponse.data.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(secondResponse.data.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(secondResponse.data.id).not.toBe(firstResponse.data.id);
    expect(secondResponse.data.code).not.toBe(firstResponse.data.code);

    const otpRows = await (async () => {
      const uow = fragments.otp.db
        .createUnitOfWork("read")
        .forSchema(otpSchema)
        .find("otp", (b) =>
          b.whereIndex("idx_otp_externalId_type_createdAt", (eb) =>
            eb.and(eb("externalId", "=", "user-1"), eb("type", "=", "email_verification")),
          ),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();

    expect(otpRows).toHaveLength(2);
    expect(otpRows.filter((otp) => otp.status === "pending")).toHaveLength(1);
    expect(otpRows.filter((otp) => otp.status === "invalidated")).toHaveLength(1);
  });

  it("reuses an issued OTP when the public route retries a request ID", async () => {
    const body = {
      externalId: "user-route-idempotent-issue",
      type: "email_verification" as const,
      durationMinutes: 30,
      payload: { email: "route-user@example.com" },
      requestId: "auth:email-verification:route-user-1",
    };

    const first = await fragments.otp.callRoute("POST", "/otp/issue", { body });
    const retried = await fragments.otp.callRoute("POST", "/otp/issue", { body });

    assert(first.type === "json");
    assert(retried.type === "json");
    expect(retried.data).toMatchObject({
      id: first.data.id,
      externalId: first.data.externalId,
      type: first.data.type,
      status: first.data.status,
      code: first.data.code,
    });
  });

  it("reuses an issued OTP when concurrent calls use the same request ID", async () => {
    const issueOtp = () =>
      fragments.otp.fragment.callServices(() =>
        fragments.otp.services.otp.issueOtp({
          externalId: "user-idempotent-issue",
          type: "email_verification",
          durationMinutes: 30,
          payload: { email: "user@example.com" },
          requestId: "auth:email-verification:user-1",
        }),
      );

    const [firstIssuedOtp, retriedIssuedOtp] = await Promise.all([issueOtp(), issueOtp()]);

    expect(retriedIssuedOtp).toMatchObject({
      status: "pending",
      id: firstIssuedOtp.id,
      externalId: firstIssuedOtp.externalId,
      type: firstIssuedOtp.type,
      code: firstIssuedOtp.code,
      payload: firstIssuedOtp.payload,
    });

    const otpRows = await (async () => {
      const uow = fragments.otp.db
        .createUnitOfWork("read")
        .forSchema(otpSchema)
        .find("otp", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", "auth:email-verification:user-1")),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();

    expect(otpRows).toHaveLength(1);
    assert(otpRows[0]?.id.valueOf() === "auth:email-verification:user-1");
    expect(otpRows[0]).toMatchObject({
      externalId: "user-idempotent-issue",
      type: "email_verification",
      status: "pending",
      payload: { email: "user@example.com" },
    });

    await drainDurableHooks(fragments.otp.fragment);
    expect(onOtpIssued).toHaveBeenCalledTimes(1);
  });

  it("returns the terminal status when a requested OTP was superseded", async () => {
    const first = await fragments.otp.fragment.callServices(() =>
      fragments.otp.services.otp.issueOtp({
        externalId: "user-superseded",
        type: "email_verification",
        durationMinutes: 30,
        requestId: "verification-request-1",
      }),
    );
    await fragments.otp.fragment.callServices(() =>
      fragments.otp.services.otp.issueOtp({
        externalId: "user-superseded",
        type: "email_verification",
        durationMinutes: 30,
        requestId: "verification-request-2",
      }),
    );

    const repeated = await fragments.otp.fragment.callServices(() =>
      fragments.otp.services.otp.issueOtp({
        externalId: "user-superseded",
        type: "email_verification",
        durationMinutes: 30,
        requestId: "verification-request-1",
      }),
    );

    expect(repeated).toMatchObject({
      id: first.id,
      code: first.code,
      status: "invalidated",
    });
  });

  it("expires rather than revives an elapsed requested OTP", async () => {
    const { test: expiringTest, fragments: expiringFragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "otp",
        instantiate(otpFragmentDefinition)
          .withConfig({ defaultExpiryMinutes: 0, hooks: { onOtpExpired } })
          .withRoutes(otpRoutes),
      )
      .build();

    try {
      const issueExpiredRequest = () =>
        expiringFragments.otp.services.otp.issueOtp({
          externalId: "user-expired-request",
          type: "email_verification",
          requestId: "verification-request-expired",
        });
      const first = await expiringFragments.otp.fragment.callServices(issueExpiredRequest);
      const repeated = await expiringFragments.otp.fragment.callServices(issueExpiredRequest);

      expect(repeated).toMatchObject({
        id: first.id,
        code: first.code,
        status: "expired",
      });
      await drainDurableHooks(expiringFragments.otp.fragment);
      expect(onOtpExpired).toHaveBeenCalledTimes(1);
    } finally {
      await expiringTest.cleanup();
    }
  });

  it("rejects invalid or conflicting caller-provided OTP request IDs", async () => {
    await expectOtpIssueError(
      fragments.otp.fragment.callServices(() =>
        fragments.otp.services.otp.issueOtp({
          externalId: "user-1",
          type: "email_verification",
          durationMinutes: 30,
          requestId: "  ",
        }),
      ),
      "OTP_REQUEST_ID_EMPTY",
    );

    await expectOtpIssueError(
      fragments.otp.fragment.callServices(() =>
        fragments.otp.services.otp.issueOtp({
          externalId: "user-1",
          type: "email_verification",
          durationMinutes: 30,
          requestId: "x".repeat(MAX_OTP_REQUEST_ID_LENGTH + 1),
        }),
      ),
      "OTP_REQUEST_ID_TOO_LONG",
    );

    await fragments.otp.fragment.callServices(() =>
      fragments.otp.services.otp.issueOtp({
        externalId: "user-1",
        type: "email_verification",
        durationMinutes: 30,
        requestId: "shared-issuance-id",
      }),
    );

    await expectOtpIssueError(
      fragments.otp.fragment.callServices(() =>
        fragments.otp.services.otp.issueOtp({
          externalId: "user-2",
          type: "email_verification",
          durationMinutes: 30,
          requestId: "shared-issuance-id",
        }),
      ),
      "OTP_REQUEST_ID_CONFLICT",
    );

    await expectOtpIssueError(
      fragments.otp.fragment.callServices(() =>
        fragments.otp.services.otp.issueOtp({
          externalId: "user-1",
          type: "password_reset",
          durationMinutes: 30,
          requestId: "shared-issuance-id",
        }),
      ),
      "OTP_REQUEST_ID_CONFLICT",
    );
  });

  it("confirms an OTP, persists its payload, and timestamps hooks at creation", async () => {
    const payload = { event: "confirm-flow", traceId: "trace-1" };
    const confirmationPayload = {
      subjectUserId: "user_auth_1",
      returnTo: "/backoffice",
    };
    const issueResponse = await fragments.otp.callRoute("POST", "/otp/issue", {
      body: { externalId: "user-2", type: "password_reset", payload },
    });
    assert(issueResponse.type === "json");

    const confirmResponse = await fragments.otp.callRoute("POST", "/otp/confirm", {
      body: {
        externalId: "user-2",
        type: "password_reset",
        code: issueResponse.data.code.toLowerCase(),
        confirmationPayload,
      },
    });
    assert(confirmResponse.type === "json");

    expect(confirmResponse.data).toEqual({
      confirmed: true,
      status: "confirmation_recorded",
    });

    await drainDurableHooks(fragments.otp.fragment);

    expect(onOtpIssued).toHaveBeenCalledTimes(1);
    expect(onOtpIssued).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: "user-2",
        type: "password_reset",
        payload,
        code: issueResponse.data.code,
        createdAt: expect.any(Date),
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(String) }),
    );

    expect(onOtpConfirmed).toHaveBeenCalledTimes(1);
    expect(onOtpConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: "user-2",
        type: "password_reset",
        payload,
        confirmationPayload,
        code: issueResponse.data.code,
        confirmedAt: expect.any(Date),
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(String) }),
    );

    const storedOtp = await (async () => {
      const uow = fragments.otp.db
        .createUnitOfWork("read")
        .forSchema(otpSchema)
        .findFirst("otp", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", issueResponse.data.id)),
        );
      await uow.executeRetrieve();
      return (await uow.retrievalPhase)[0];
    })();
    assert(storedOtp?.status === "confirmed");
    expect(storedOtp?.confirmationPayload).toEqual(confirmationPayload);
    expect(storedOtp?.confirmedAt).toBeInstanceOf(Date);
  });

  it("treats repeated confirmation of an already confirmed OTP as idempotent", async () => {
    const issueResponse = await fragments.otp.callRoute("POST", "/otp/issue", {
      body: { externalId: "user-idempotent", type: "password_reset" },
    });
    assert(issueResponse.type === "json");

    const firstConfirmResponse = await fragments.otp.callRoute("POST", "/otp/confirm", {
      body: {
        externalId: "user-idempotent",
        type: "password_reset",
        code: issueResponse.data.code,
        confirmationPayload: { subjectUserId: "user_auth_1" },
      },
    });
    assert(firstConfirmResponse.type === "json");
    expect(firstConfirmResponse.data).toEqual({
      confirmed: true,
      status: "confirmation_recorded",
    });

    const repeatedConfirmResponse = await fragments.otp.callRoute("POST", "/otp/confirm", {
      body: {
        externalId: "user-idempotent",
        type: "password_reset",
        code: issueResponse.data.code,
        confirmationPayload: { subjectUserId: "user_auth_2" },
      },
    });
    assert(repeatedConfirmResponse.type === "json");
    expect(repeatedConfirmResponse.data).toEqual({
      confirmed: true,
      status: "already_confirmed",
    });

    await drainDurableHooks(fragments.otp.fragment);
    expect(onOtpConfirmed).toHaveBeenCalledTimes(1);
  });

  it("rejects replay of a confirmed code after a newer challenge is issued", async () => {
    const { test: replayTest, fragments: replayFragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "otp",
        instantiate(otpFragmentDefinition)
          .withConfig({
            alphabet: "ABCDEF",
            codeLength: 1,
          })
          .withRoutes(otpRoutes),
      )
      .build();

    try {
      const firstIssueResponse = await replayFragments.otp.callRoute("POST", "/otp/issue", {
        body: { externalId: "user-replay", type: "password_reset" },
      });
      assert(firstIssueResponse.type === "json");

      const firstConfirmResponse = await replayFragments.otp.callRoute("POST", "/otp/confirm", {
        body: {
          externalId: "user-replay",
          type: "password_reset",
          code: firstIssueResponse.data.code,
        },
      });
      assert(firstConfirmResponse.type === "json");
      assert(firstConfirmResponse.data.confirmed);

      let latestCode: string | null = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        const issueResponse = await replayFragments.otp.callRoute("POST", "/otp/issue", {
          body: { externalId: "user-replay", type: "password_reset" },
        });
        assert(issueResponse.type === "json");

        if (issueResponse.data.code !== firstIssueResponse.data.code) {
          latestCode = issueResponse.data.code;
          break;
        }
      }

      if (!latestCode) {
        throw new Error("Could not issue a different replay test code.");
      }

      const replayResponse = await replayFragments.otp.callRoute("POST", "/otp/confirm", {
        body: {
          externalId: "user-replay",
          type: "password_reset",
          code: firstIssueResponse.data.code,
        },
      });
      assert(replayResponse.type === "error");
      assert(replayResponse.status === 401);
      assert(replayResponse.error.code === "OTP_INVALID");

      const latestConfirmResponse = await replayFragments.otp.callRoute("POST", "/otp/confirm", {
        body: {
          externalId: "user-replay",
          type: "password_reset",
          code: latestCode,
        },
      });
      assert(latestConfirmResponse.type === "json");
      assert(latestConfirmResponse.data.confirmed);
    } finally {
      await replayTest.cleanup();
    }
  });

  it("returns OTP_EXPIRED for expired OTPs and timestamps the expiry hook at creation", async () => {
    const { test: expiringTest, fragments: expiringFragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
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
      const payload = { event: "expire-flow", traceId: "trace-2" };
      const issueResponse = await expiringFragments.otp.callRoute("POST", "/otp/issue", {
        body: { externalId: "user-3", type: "passwordless_login", payload },
      });
      assert(issueResponse.type === "json");

      const confirmResponse = await expiringFragments.otp.callRoute("POST", "/otp/confirm", {
        body: {
          externalId: "user-3",
          type: "passwordless_login",
          code: issueResponse.data.code,
        },
      });
      assert(confirmResponse.type === "error");
      assert(confirmResponse.status === 410);
      assert(confirmResponse.error.code === "OTP_EXPIRED");

      await drainDurableHooks(expiringFragments.otp.fragment);

      expect(onOtpExpired).toHaveBeenCalledTimes(1);
      expect(onOtpExpired).toHaveBeenCalledWith(
        expect.objectContaining({
          id: issueResponse.data.id,
          externalId: "user-3",
          payload,
          type: "passwordless_login",
          code: issueResponse.data.code,
          expiredAt: expect.any(Date),
        }),
        expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(String) }),
      );

      const storedOtp = await (async () => {
        const uow = expiringFragments.otp.db
          .createUnitOfWork("read")
          .forSchema(otpSchema)
          .findFirst("otp", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", issueResponse.data.id)),
          );
        await uow.executeRetrieve();
        return (await uow.retrievalPhase)[0];
      })();
      assert(storedOtp?.status === "expired");
      expect(storedOtp?.expiredAt).toBeInstanceOf(Date);
    } finally {
      await expiringTest.cleanup();
    }
  });

  it("confirms lowercase OTPs exactly when a custom lowercase alphabet is configured", async () => {
    const { test: lowercaseTest, fragments: lowercaseFragments } =
      await buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "kysely-sqlite" })
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
        body: { externalId: "user-5", type: "email_verification" },
      });
      assert(issueResponse.type === "json");
      expect(issueResponse.data.code).toMatch(/^[abcdef123]{6}$/);

      const confirmResponse = await lowercaseFragments.otp.callRoute("POST", "/otp/confirm", {
        body: {
          externalId: "user-5",
          type: "email_verification",
          code: issueResponse.data.code,
        },
      });
      assert(confirmResponse.type === "json");
      assert(confirmResponse.data.confirmed);
    } finally {
      await lowercaseTest.cleanup();
    }
  });

  it("requires exact case matching when confirming mixed-case OTPs", async () => {
    const { test: mixedCaseTest, fragments: mixedCaseFragments } =
      await buildDatabaseFragmentsTest()
        .withTestAdapter({ type: "kysely-sqlite" })
        .withFragment(
          "otp",
          instantiate(otpFragmentDefinition)
            .withConfig({
              alphabet: "AaBbCc",
              codeLength: 1,
            })
            .withRoutes(otpRoutes),
        )
        .build();

    try {
      const issueResponse = await mixedCaseFragments.otp.callRoute("POST", "/otp/issue", {
        body: { externalId: "user-7", type: "email_verification" },
      });
      assert(issueResponse.type === "json");
      expect(issueResponse.data.code).toMatch(/^[AaBbCc]$/);

      const mixedCaseCode = issueResponse.data.code;
      const mismatchedCaseCode =
        mixedCaseCode === mixedCaseCode.toUpperCase()
          ? mixedCaseCode.toLowerCase()
          : mixedCaseCode.toUpperCase();

      const mismatchedResponse = await mixedCaseFragments.otp.callRoute("POST", "/otp/confirm", {
        body: {
          externalId: "user-7",
          type: "email_verification",
          code: mismatchedCaseCode,
        },
      });
      assert(mismatchedResponse.type === "error");
      assert(mismatchedResponse.status === 401);
      assert(mismatchedResponse.error.code === "OTP_INVALID");

      const exactMatchResponse = await mixedCaseFragments.otp.callRoute("POST", "/otp/confirm", {
        body: {
          externalId: "user-7",
          type: "email_verification",
          code: mixedCaseCode,
        },
      });
      assert(exactMatchResponse.type === "json");
      assert(exactMatchResponse.data.confirmed);
    } finally {
      await mixedCaseTest.cleanup();
    }
  });

  it("persists expiry immediately when confirmation observes an expired OTP", async () => {
    const { test: expiringTest, fragments: expiringFragments } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
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
      const payload = { event: "persisted-expiry", traceId: "trace-3" };
      const issueResponse = await expiringFragments.otp.callRoute("POST", "/otp/issue", {
        body: { externalId: "user-6", type: "password_reset", payload },
      });
      assert(issueResponse.type === "json");

      const confirmResponse = await expiringFragments.otp.callRoute("POST", "/otp/confirm", {
        body: {
          externalId: "user-6",
          type: "password_reset",
          code: issueResponse.data.code,
        },
      });
      assert(confirmResponse.type === "error");
      assert(confirmResponse.status === 410);
      assert(confirmResponse.error.code === "OTP_EXPIRED");

      const storedAfterConfirm = await (async () => {
        const uow = expiringFragments.otp.db
          .createUnitOfWork("read")
          .forSchema(otpSchema)
          .findFirst("otp", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", issueResponse.data.id)),
          );
        await uow.executeRetrieve();
        return (await uow.retrievalPhase)[0];
      })();
      assert(storedAfterConfirm?.status === "expired");
      expect(storedAfterConfirm?.expiredAt).toBeInstanceOf(Date);
      expect(storedAfterConfirm?.invalidatedAt).toBeNull();

      const invalidateResponse = await expiringFragments.otp.callRoute("POST", "/otp/invalidate", {
        body: {
          externalId: "user-6",
          type: "password_reset",
        },
      });
      assert(invalidateResponse.type === "json");
      assert(invalidateResponse.data.invalidatedCount === 0);

      await drainDurableHooks(expiringFragments.otp.fragment);

      expect(onOtpExpired).toHaveBeenCalledWith(
        expect.objectContaining({
          id: issueResponse.data.id,
          externalId: "user-6",
          payload,
          type: "password_reset",
          code: issueResponse.data.code,
          expiredAt: expect.any(Date),
        }),
        expect.objectContaining({ idempotencyKey: expect.any(String), hookId: expect.any(String) }),
      );

      const storedAfterHooks = await (async () => {
        const uow = expiringFragments.otp.db
          .createUnitOfWork("read")
          .forSchema(otpSchema)
          .findFirst("otp", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", issueResponse.data.id)),
          );
        await uow.executeRetrieve();
        return (await uow.retrievalPhase)[0];
      })();
      assert(storedAfterHooks?.status === "expired");
      expect(storedAfterHooks?.invalidatedAt).toBeNull();
    } finally {
      await expiringTest.cleanup();
    }
  });

  it("invalidates pending OTPs without confirming them", async () => {
    const issueResponse = await fragments.otp.callRoute("POST", "/otp/issue", {
      body: { externalId: "user-4", type: "email_verification" },
    });
    assert(issueResponse.type === "json");

    const invalidateResponse = await fragments.otp.callRoute("POST", "/otp/invalidate", {
      body: { externalId: "user-4", type: "email_verification" },
    });
    assert(invalidateResponse.type === "json");
    expect(invalidateResponse.data).toEqual({ invalidatedCount: 1 });

    const confirmResponse = await fragments.otp.callRoute("POST", "/otp/confirm", {
      body: {
        externalId: "user-4",
        type: "email_verification",
        code: issueResponse.data.code,
      },
    });
    assert(confirmResponse.type === "error");
    assert(confirmResponse.status === 401);
    assert(confirmResponse.error.code === "OTP_INVALID");
  });
});
