import { beforeAll, afterAll, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import {
  defineWorkflow,
  workflowsFragmentDefinition,
  workflowsRoutesFactory,
  type WorkflowEvent,
  type WorkflowStep,
} from "@fragno-dev/workflows";
import { toNodeHandler } from "@fragno-dev/node";
import { createClient } from "./client.js";

const DemoWorkflow = defineWorkflow(
  { name: "demo-workflow" },
  (_event: WorkflowEvent<{ userId: string }>, _step: WorkflowStep) => {
    return undefined;
  },
);

describe("workflows CLI client", async () => {
  const workflows = {
    DEMO: DemoWorkflow,
  } as const;

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment(
      "workflows",
      instantiate(workflowsFragmentDefinition)
        .withConfig({ workflows, runtime: defaultFragnoRuntime })
        .withRoutes([workflowsRoutesFactory]),
    )
    .build();

  const { fragment } = fragments.workflows;
  let server: Server;
  let client: ReturnType<typeof createClient>;

  beforeAll(() => {
    server = createServer(toNodeHandler(fragment.handler));
    server.listen(0);

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server address unavailable");
    }

    const baseUrl = `http://localhost:${address.port}${fragment.mountRoute}`;
    client = createClient({
      baseUrl,
      timeoutMs: 5000,
      retries: 0,
      retryDelayMs: 0,
    });
  });

  afterAll(async () => {
    server.close();
    await testContext.cleanup();
  });

  beforeEach(async () => {
    await testContext.resetDatabase();
  });

  test("lists workflows", async () => {
    const response = await client.listWorkflows();
    expect(response.workflows).toEqual([{ name: "demo-workflow" }]);
  });

  test("creates and fetches an instance", async () => {
    const created = await client.createInstance({
      workflowName: "demo-workflow",
      params: { userId: "u_1" },
    });

    expect(created.id).toBeDefined();

    const fetched = await client.getInstance({
      workflowName: "demo-workflow",
      instanceId: created.id,
    });

    expect(fetched.meta["workflowName"]).toBe("demo-workflow");
    expect(fetched.id).toBe(created.id);
  });

  test("lists instances", async () => {
    const created = await client.createInstance({ workflowName: "demo-workflow" });

    const response = await client.listInstances({ workflowName: "demo-workflow" });
    const ids = response.instances.map((instance) => instance.id);

    expect(ids).toContain(created.id);
  });
});
