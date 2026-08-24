import { assert, describe, expect, test } from "vitest";

import {
  backofficeCapabilities,
  getBackofficeCapabilityKind,
  listAutomationEventDescriptors,
  listCapabilityEventSources,
  toConnectionVerification,
} from "./backoffice-capabilities";

describe("Capability contributions", () => {
  test("declares user-facing event sources independently from automation event descriptors", () => {
    expect(
      listCapabilityEventSources()
        .map((eventSource) => eventSource.source)
        .sort(),
    ).toEqual(["auth", "automations", "github", "otp", "sandbox", "scheduler", "telegram"]);

    const automationEventSources = new Set(
      listAutomationEventDescriptors().map((event) => event.source),
    );
    expect(automationEventSources).toContain("api");
    expect(automationEventSources).toContain("mcp");
    assert(!listCapabilityEventSources().some((eventSource) => eventSource.source === "api"));
    assert(!listCapabilityEventSources().some((eventSource) => eventSource.source === "mcp"));
  });

  test("keeps normalized GitHub events out of the built-in catalog", () => {
    const github = backofficeCapabilities.find((capability) => capability.id === "github");
    assert(github);

    expect(github.contributions.automationEvents.map((event) => event.eventType)).toEqual([
      "webhook.received",
    ]);
  });

  test("derives legacy system and connection kinds from connection contributions", () => {
    expect(
      Object.fromEntries(
        backofficeCapabilities.map((capability) => [
          capability.id,
          getBackofficeCapabilityKind(capability),
        ]),
      ),
    ).toMatchObject({
      api: "system",
      mcp: "system",
      pi: "connection",
      telegram: "connection",
    });
  });
});

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
