import { assert, describe, expect, test } from "vitest";

import {
  backofficeCapabilities,
  getBackofficeCapabilityKind,
  listAutomationEventDescriptors,
  listCapabilityEventSources,
} from "./backoffice-capabilities";

describe("Capability contributions", () => {
  test("declares user-facing event sources independently from automation event descriptors", () => {
    expect(
      listCapabilityEventSources()
        .map((eventSource) => eventSource.source)
        .sort(),
    ).toEqual([
      "auth",
      "automations",
      "codemode",
      "forms",
      "github",
      "integrations",
      "otp",
      "pi",
      "sandbox",
      "scheduler",
      "telegram",
    ]);

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
      connector: "system",
      pi: "system",
      telegram: "connection",
    });
  });
});
