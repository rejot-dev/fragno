import { describe, expect, test, vi } from "vitest";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";

import { createRouteBackedAutomationIdentityRuntime } from "./external-identities-route-runtime";

const execution: BackofficeExecutionContext = {
  scope: { kind: "org", orgId: "org-1" },
  actors: {
    initiator: {
      scope: "external",
      source: "telegram",
      type: "chat",
      id: "1001",
      role: "initiator",
    },
    principal: {
      scope: "internal",
      type: "automation",
      id: "automation:event-1",
      role: "principal",
    },
    delegation: [],
  },
};

describe("route-backed external identity runtime", () => {
  test("forwards the workflow identity choice with trusted execution", async () => {
    const resolveExternalIdentity = vi.fn(async () => ({ userId: "user-1" }));
    const runtime = createRouteBackedAutomationIdentityRuntime({
      object: { resolveExternalIdentity } as never,
      execution,
    });

    await expect(
      runtime.resolveExternal({ source: "telegram", type: "chat", id: "1001" }),
    ).resolves.toEqual({ userId: "user-1" });
    expect(resolveExternalIdentity).toHaveBeenCalledWith(
      {
        identity: {
          scope: "external",
          source: "telegram",
          type: "chat",
          id: "1001",
        },
      },
      { execution },
    );
  });
});
