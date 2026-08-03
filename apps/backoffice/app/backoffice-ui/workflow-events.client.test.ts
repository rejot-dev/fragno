// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi, assert } from "vitest";

import { sendBackofficeWorkflowEvent } from "./workflow-events.client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendBackofficeWorkflowEvent", () => {
  test("sends a typed idempotent event through the project-scoped workflows route", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return Response.json({ accepted: true });
      }),
    );

    await expect(
      sendBackofficeWorkflowEvent({
        eventId: "event-1",
        reference: {
          scope: { kind: "project", orgId: "org-1", projectId: "project/one" },
          workflowName: "reson8-setup",
          instanceId: "instance-1",
        },
        eventType: "reson8-setup-submitted",
        payload: { apiKey: "secret" },
      }),
    ).resolves.toEqual({ accepted: true });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    assert(
      new URL(request.url).pathname ===
        "/api/automations-scoped/project/org-1%3Aproject%252Fone/workflows/reson8-setup/instances/instance-1/events",
    );
    expect(await request.json()).toEqual({
      id: "event-1",
      type: "reson8-setup-submitted",
      payload: { apiKey: "secret" },
    });
  });
});
