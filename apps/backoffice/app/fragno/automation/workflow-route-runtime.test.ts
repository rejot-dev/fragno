import { describe, expect, test } from "vitest";

import type { AutomationsObject } from "@/backoffice-runtime/object-registry";

import { CODEMODE_WORKFLOW } from "./engine/codemode-invocation";
import { createRouteBackedAutomationWorkflowRuntime } from "./workflow-route-runtime";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const createObject = (handle: (request: Request) => Response | Promise<Response>) =>
  ({ fetch: handle }) as unknown as AutomationsObject;

describe("createRouteBackedAutomationWorkflowRuntime", () => {
  test("pins every public saved-workflow operation to the shared workflow host", async () => {
    const paths: string[] = [];
    const object = createObject((request) => {
      const url = new URL(request.url);
      paths.push(url.pathname);
      if (url.pathname.endsWith("/retry-failed-step")) {
        return jsonResponse({
          accepted: true,
          instance: { id: "run-1", details: { status: "waiting" } },
          retry: {
            stepKey: "do:latest",
            attempts: 1,
            maxAttempts: 2,
            scheduledAt: "2026-08-11T00:00:00.000Z",
          },
        });
      }
      if (url.pathname.endsWith("/events")) {
        return jsonResponse({ accepted: true });
      }
      if (url.pathname.endsWith("/history")) {
        return jsonResponse({ steps: [], events: [], emissions: [] });
      }
      return jsonResponse({ instances: [], hasNextPage: false });
    });
    const runtime = createRouteBackedAutomationWorkflowRuntime({ object });
    const forgedHost = { workflowName: "internal-secret-host" };

    await runtime.listInstances(forgedHost as never);
    await runtime.retryFailedStep({
      ...forgedHost,
      instanceId: "run-1",
    } as never);
    await runtime.sendEvent({
      ...forgedHost,
      instanceId: "run-1",
      type: "continue",
    } as never);
    await runtime.getHistory({ ...forgedHost, instanceId: "run-1" } as never);

    expect(paths).toEqual([
      `/api/workflows/${CODEMODE_WORKFLOW}/instances`,
      `/api/workflows/${CODEMODE_WORKFLOW}/instances/run-1/retry-failed-step`,
      `/api/workflows/${CODEMODE_WORKFLOW}/instances/run-1/events`,
      `/api/workflows/${CODEMODE_WORKFLOW}/instances/run-1/history`,
    ]);
  });

  test("projects saved-workflow details from narrow metadata while allowing backend additions", async () => {
    const object = createObject(() =>
      jsonResponse({
        id: "run-1",
        details: { status: "complete", output: { ok: true } },
        meta: {
          workflowName: CODEMODE_WORKFLOW,
          remoteWorkflowName: "demo",
          params: {
            program: {
              workflowName: "demo",
              filename: "/workspace/automations/demo.workflow.js",
              code: 42,
              dependencies: "backend-owned-shape",
            },
            execution: "unused-by-this-projection",
          },
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:01:00.000Z",
          startedAt: null,
          completedAt: "2026-08-11T00:01:00.000Z",
          currentStep: null,
          futureBackendField: { supported: true },
        },
      }),
    );
    const runtime = createRouteBackedAutomationWorkflowRuntime({ object });

    await expect(runtime.getInstance({ instanceId: "run-1" })).resolves.toEqual({
      id: "run-1",
      details: { status: "complete", output: { ok: true } },
      meta: {
        name: "demo",
        path: "/workspace/automations/demo.workflow.js",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:01:00.000Z",
        startedAt: null,
        completedAt: "2026-08-11T00:01:00.000Z",
      },
    });
  });
});
