import { test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { createNodeBackofficeRuntimeEnv } from "@/backoffice-runtime/node/node-runtime-env";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";

const denoCheckpointedWorkflowSource = `defineWorkflow(
  { name: "deno-codemode-checkpointed", checkpoint: "step" },
  async (_event, step) => {
    const first = await step.do("first", async () => 1);
    const second = await step.do("second", async () => first + 1);
    return await step.do("third", async () => second + 1);
  },
);`;

test("Node runs checkpointed Backoffice workflow codemode through Deno", async () => {
  const env = await createNodeBackofficeRuntimeEnv({
    denoExecutable: process.env.DENO_EXECUTABLE,
    env: {},
  });
  const scope = { kind: "org" as const, orgId: "org-1" };
  const execution = createBackofficeSystemExecution(scope);

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Node runs checkpointed workflow codemode through Deno",
      env,
      files: backofficeFiles.workspaceStarter({
        "automations/deno-codemode-checkpointed.workflow.js": denoCheckpointedWorkflowSource,
      }),
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: "org-1",
          path: "/workspace/automations/deno-codemode-checkpointed.workflow.js",
          remoteWorkflowName: "deno-codemode-checkpointed",
          instanceId: "deno-codemode-checkpointed-1",
          event: {
            id: "deno-codemode-checkpointed-event",
            scope,
            source: "scenario",
            eventType: "deno.workflow.requested",
            occurredAt: "2026-09-25T00:00:00.000Z",
            payload: {},
            actors: execution.actors,
          },
        }),
        then.workflow.instance({
          remoteWorkflowName: "deno-codemode-checkpointed",
          instanceId: "deno-codemode-checkpointed-1",
          status: "complete",
          output: 3,
        }),
        then.workflow.steps({
          remoteWorkflowName: "deno-codemode-checkpointed",
          instanceId: "deno-codemode-checkpointed-1",
          include: ["first", "second", "third"],
        }),
      ],
    }),
  );
});
