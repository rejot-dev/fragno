import { describe, expect, test } from "vitest";

import {
  appendAutomationDelegate,
  AutomationAuthorityModeError,
  automationRouteAuthority,
  createAutomationRuntimeExecution,
} from "../authority";
import type { AutomationEvent } from "../contracts";

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

const organizationAuthority = automationRouteAuthority({
  routeId: "telegram-message",
  mode: { kind: "organization-automation" },
});

const delegatedUserAuthority = automationRouteAuthority({
  routeId: "telegram-message",
  mode: { kind: "delegated-user" },
});

describe("createAutomationRuntimeExecution", () => {
  test("uses a stable route automation principal without replacing the initiator", () => {
    expect(createAutomationRuntimeExecution({ event, authority: organizationAuthority })).toEqual({
      scope: event.scope,
      actors: {
        initiator: event.actors.initiator,
        principal: {
          scope: "internal",
          type: "automation",
          id: "automation-route:telegram-message",
          role: "principal",
        },
        delegation: [],
      },
    });
  });

  test("uses the same organization automation principal for different events", () => {
    const first = createAutomationRuntimeExecution({ event, authority: organizationAuthority });
    const second = createAutomationRuntimeExecution({
      event: { ...event, id: "event-2" },
      authority: organizationAuthority,
    });

    expect(second.actors.principal).toEqual(first.actors.principal);
  });

  test("preserves a delegated user principal and appends the route automation", () => {
    const principal = {
      scope: "internal",
      type: "user",
      id: "user-1",
      role: "principal",
    } as const;

    expect(
      createAutomationRuntimeExecution({
        event: { ...event, actors: { ...event.actors, principal } },
        authority: delegatedUserAuthority,
      }).actors,
    ).toEqual({
      initiator: event.actors.initiator,
      principal,
      delegation: [
        {
          scope: "internal",
          type: "automation",
          id: "automation-route:telegram-message",
          role: "delegate",
        },
      ],
    });
  });

  test("does not duplicate a route automation already in the delegation", () => {
    const routeDelegate = {
      scope: "internal",
      type: "automation",
      id: "automation-route:telegram-message",
      role: "delegate",
    } as const;
    const execution = createAutomationRuntimeExecution({
      event: {
        ...event,
        actors: {
          ...event.actors,
          principal: {
            scope: "internal",
            type: "user",
            id: "user-1",
            role: "principal",
          },
          delegation: [routeDelegate],
        },
      },
      authority: delegatedUserAuthority,
    });

    expect(execution.actors.delegation).toEqual([routeDelegate]);
  });

  test("rejects delegated-user mode without a principal", () => {
    expect(() =>
      createAutomationRuntimeExecution({ event, authority: delegatedUserAuthority }),
    ).toThrow(
      expect.objectContaining<Partial<AutomationAuthorityModeError>>({
        reason: "delegated-user-principal-required",
      }),
    );
  });

  test("appends a trusted delegate without replacing existing authority", () => {
    const execution = createAutomationRuntimeExecution({ event, authority: organizationAuthority });

    expect(
      appendAutomationDelegate({
        execution,
        delegate: {
          scope: "internal",
          type: "capability",
          id: "codemode-script",
          role: "delegate",
        },
      }).actors,
    ).toEqual({
      ...execution.actors,
      delegation: [
        {
          scope: "internal",
          type: "capability",
          id: "codemode-script",
          role: "delegate",
        },
      ],
    });
  });

  test("rejects delegated-user mode with a non-user principal", () => {
    expect(() =>
      createAutomationRuntimeExecution({
        event: {
          ...event,
          actors: {
            ...event.actors,
            principal: {
              scope: "internal",
              type: "service",
              id: "service-1",
              role: "principal",
            },
          },
        },
        authority: delegatedUserAuthority,
      }),
    ).toThrow(
      expect.objectContaining<Partial<AutomationAuthorityModeError>>({
        reason: "delegated-user-principal-invalid",
      }),
    );
  });
});
