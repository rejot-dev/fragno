import { describe, expect, test } from "vitest";

import type { AutomationEvent } from "../contracts";
import { createAutomationRuntimeExecution } from "./runtime-execution";

const event = {
  id: "event-1",
  scope: { kind: "org", orgId: "org-1" },
  source: "telegram",
  eventType: "telegram.message.received",
  occurredAt: "2026-07-27T00:00:00.000Z",
  payload: {},
  subject: null,
  actors: {
    initiator: {
      scope: "external",
      source: "telegram",
      type: "chat",
      id: "chat-1",
      role: "initiator",
    },
    principal: null,
    delegation: [],
  },
} as const satisfies AutomationEvent;

describe("createAutomationRuntimeExecution", () => {
  test("uses the automation runtime as principal without replacing the external initiator", () => {
    expect(createAutomationRuntimeExecution(event)).toEqual({
      scope: event.scope,
      actors: {
        initiator: event.actors.initiator,
        principal: {
          scope: "internal",
          type: "automation",
          id: "automation:event-1",
          role: "principal",
        },
        delegation: [],
      },
    });
  });

  test("keeps a system initiator principal-free and authorizes the runtime as a delegate", () => {
    const systemEvent = {
      ...event,
      scope: { kind: "system" as const },
      actors: {
        initiator: {
          scope: "internal" as const,
          type: "system",
          id: "backoffice",
          role: "initiator" as const,
        },
        principal: null,
        delegation: [],
      },
    };

    expect(createAutomationRuntimeExecution(systemEvent)).toEqual({
      scope: systemEvent.scope,
      actors: {
        initiator: systemEvent.actors.initiator,
        principal: null,
        delegation: [
          {
            scope: "internal",
            type: "automation",
            id: "automation:event-1",
            role: "delegate",
          },
        ],
      },
    });
  });

  test("adds the automation runtime as a delegate when the event has a principal", () => {
    const principal = {
      scope: "internal",
      type: "user",
      id: "user-1",
      role: "principal",
    } as const;

    expect(
      createAutomationRuntimeExecution({
        ...event,
        actors: { ...event.actors, principal },
      }).actors,
    ).toEqual({
      initiator: event.actors.initiator,
      principal,
      delegation: [
        {
          scope: "internal",
          type: "automation",
          id: "automation:event-1",
          role: "delegate",
        },
      ],
    });
  });

  test("does not duplicate an automation identity already in the delegation", () => {
    const principal = {
      scope: "internal",
      type: "user",
      id: "user-1",
      role: "principal",
    } as const;
    const delegate = {
      scope: "internal",
      type: "automation",
      id: "automation:event-1",
      role: "delegate",
    } as const;

    expect(
      createAutomationRuntimeExecution({
        ...event,
        actors: { ...event.actors, principal, delegation: [delegate] },
      }).actors.delegation,
    ).toEqual([delegate]);
  });
});
