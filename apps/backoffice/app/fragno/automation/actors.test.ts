import { describe, expect, test } from "vitest";

import { automationActorsSchema, type AutomationActors } from "./actors";

const telegramInitiator = {
  scope: "external",
  source: "telegram",
  type: "chat",
  id: "1001",
  role: "initiator",
} as const satisfies AutomationActors["initiator"];

const userPrincipal = {
  scope: "internal",
  type: "user",
  id: "user-1",
  role: "principal",
} as const satisfies NonNullable<AutomationActors["principal"]>;

describe("AutomationActors", () => {
  test("accepts unlinked, linked, and delegated provenance", () => {
    const unlinked = automationActorsSchema.parse({
      initiator: telegramInitiator,
      principal: null,
      delegation: [],
    });
    const linked = automationActorsSchema.parse({
      initiator: telegramInitiator,
      principal: userPrincipal,
      delegation: [],
    });
    const delegated = automationActorsSchema.parse({
      initiator: telegramInitiator,
      principal: userPrincipal,
      delegation: [
        {
          scope: "internal",
          type: "automation",
          id: "automation:event-1",
          role: "delegate",
        },
        {
          scope: "internal",
          type: "agent",
          id: "agent-1",
          role: "assistant",
        },
      ],
    });

    expect(unlinked.principal).toBeNull();
    expect(linked.principal).toEqual(userPrincipal);
    expect(delegated.delegation.map((actor) => actor.role)).toEqual(["delegate", "assistant"]);
  });

  test("rejects actors placed in the wrong structural slot", () => {
    expect(() =>
      automationActorsSchema.parse({
        initiator: telegramInitiator,
        principal: {
          scope: "internal",
          type: "agent",
          id: "agent-1",
          role: "assistant",
        },
        delegation: [],
      }),
    ).toThrow();

    expect(() =>
      automationActorsSchema.parse({
        initiator: telegramInitiator,
        principal: null,
        delegation: [userPrincipal],
      }),
    ).toThrow();
  });

  test("rejects duplicate identities across slots and delegation", () => {
    expect(() =>
      automationActorsSchema.parse({
        initiator: telegramInitiator,
        principal: null,
        delegation: [
          {
            ...telegramInitiator,
            role: "delegate",
          },
        ],
      }),
    ).toThrow("Automation actor provenance contains duplicate identities");
  });

  test("requires sources only on external actors and rejects unknown actor fields", () => {
    expect(() =>
      automationActorsSchema.parse({
        initiator: {
          scope: "external",
          type: "chat",
          id: "1001",
          role: "initiator",
        },
        principal: null,
        delegation: [],
      }),
    ).toThrow();

    expect(() =>
      automationActorsSchema.parse({
        initiator: {
          scope: "internal",
          source: "telegram",
          type: "user",
          id: "user-1",
          role: "initiator",
        },
        principal: null,
        delegation: [],
      }),
    ).toThrow();

    expect(() =>
      automationActorsSchema.parse({
        initiator: { ...telegramInitiator, email: "user@example.com" },
        principal: null,
        delegation: [],
      }),
    ).toThrow();
  });
});
