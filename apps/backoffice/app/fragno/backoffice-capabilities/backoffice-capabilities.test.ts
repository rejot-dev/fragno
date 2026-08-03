import { describe, expect, test } from "vitest";

import { toConnectionVerification } from "./backoffice-capabilities";

describe("toConnectionVerification", () => {
  test("verifies present configuration when a capability has no specific health check", () => {
    expect(
      toConnectionVerification({
        id: "reson8",
        label: "Reson8",
        kind: "connection",
        configured: true,
      }),
    ).toEqual({
      id: "reson8",
      label: "Reson8",
      kind: "connection",
      configured: true,
      verification: {
        ok: true,
        message: "Reson8 configuration is present.",
      },
    });
  });

  test("fails verification when required configuration is absent", () => {
    expect(
      toConnectionVerification({
        id: "reson8",
        label: "Reson8",
        kind: "connection",
        configured: false,
        missing: ["apiKey"],
      }).verification,
    ).toEqual({
      ok: false,
      message: "Reson8 is not configured.",
    });
  });

  test("preserves a capability-specific verification result", () => {
    expect(
      toConnectionVerification({
        id: "telegram",
        label: "Telegram",
        kind: "connection",
        configured: true,
        verification: {
          ok: false,
          message: "Telegram rejected the webhook.",
        },
      }).verification,
    ).toEqual({
      ok: false,
      message: "Telegram rejected the webhook.",
    });
  });
});
