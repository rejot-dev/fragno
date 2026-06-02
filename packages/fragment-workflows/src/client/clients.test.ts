import { assert, describe, expect, test } from "vitest";

import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { workflowsFragmentDefinition } from "../definition";
import { workflowsRoutesFactory } from "../routes";
import { defineWorkflow } from "../workflow";
import { createWorkflowsClient } from "./vanilla";

const DemoWorkflow = defineWorkflow({ name: "demo-workflow" }, () => undefined);

const collectStoreValues = async <T>(
  store: { listen: (callback: (value: T) => void) => () => void },
  count: number,
) =>
  new Promise<T[]>((resolve) => {
    const values: T[] = [];
    let unsubscribe: (() => void) | undefined;
    unsubscribe = store.listen((value) => {
      values.push(value);
      if (values.length === count) {
        queueMicrotask(() => unsubscribe?.());
        resolve(values);
      }
    });
  });

const setup = async () => {
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "workflows",
      instantiate(workflowsFragmentDefinition)
        .withConfig({
          workflows: { DEMO: DemoWorkflow },
          autoTickHooks: false,
          runtime: defaultFragnoRuntime,
        })
        .withRoutes([workflowsRoutesFactory]),
    )
    .build();

  const fragment = fragments.workflows.fragment;
  const baseUrl = "http://fragno.test";
  const clientConfig: FragnoPublicClientConfig = {
    baseUrl,
    mountRoute: fragment.mountRoute,
    fetcherConfig: {
      type: "function",
      useOnServer: true,
      fetcher: (input, init) => {
        const request =
          input instanceof Request ? input : new Request(new URL(String(input), baseUrl), init);
        return fragment.handler(request);
      },
    },
  };

  return { client: createWorkflowsClient(clientConfig), fragment, testContext };
};

describe("workflows client pagination", () => {
  test("useWorkflowInstances pages with nextCursor from a real sqlite-backed workflow fragment", async () => {
    const { client, fragment, testContext } = await setup();
    try {
      for (let index = 0; index < 5; index += 1) {
        const response = await fragment.callRoute("POST", "/:workflowName/instances", {
          pathParams: { workflowName: "demo-workflow" },
          body: { id: `client-cursor-${index}` },
        });
        assert(response.type === "json");
      }

      const firstPageStore = client.useWorkflowInstances({
        path: { workflowName: "demo-workflow" },
        query: { pageSize: "2" } as never,
      });
      const [, firstPage] = await collectStoreValues(firstPageStore, 2);

      assert(firstPage.data);
      expect(firstPage.data.instances).toHaveLength(2);
      expect(firstPage.data.hasNextPage).toBe(true);
      expect(firstPage.data.nextCursor).toEqual(expect.any(String));
      expect(firstPage.data).not.toHaveProperty("cursor");

      const secondPageStore = client.useWorkflowInstances({
        path: { workflowName: "demo-workflow" },
        query: { pageSize: "2", cursor: firstPage.data.nextCursor } as never,
      });
      const [, secondPage] = await collectStoreValues(secondPageStore, 2);

      assert(secondPage.data);
      expect(secondPage.data.instances).toHaveLength(2);
      expect(secondPage.data.hasNextPage).toBe(true);
      expect(secondPage.data.nextCursor).toEqual(expect.any(String));
      expect(secondPage.data).not.toHaveProperty("cursor");

      const thirdPageStore = client.useWorkflowInstances({
        path: { workflowName: "demo-workflow" },
        query: { pageSize: "2", cursor: secondPage.data.nextCursor } as never,
      });
      const [, thirdPage] = await collectStoreValues(thirdPageStore, 2);

      assert(thirdPage.data);
      expect(thirdPage.data.instances).toHaveLength(1);
      expect(thirdPage.data.hasNextPage).toBe(false);
      expect(thirdPage.data.nextCursor).toBeUndefined();
      expect(thirdPage.data).not.toHaveProperty("cursor");

      const seenIds = [
        ...firstPage.data.instances,
        ...secondPage.data.instances,
        ...thirdPage.data.instances,
      ].map((instance) => instance.id);
      expect(new Set(seenIds).size).toBe(5);
      expect(seenIds.sort()).toEqual([
        "client-cursor-0",
        "client-cursor-1",
        "client-cursor-2",
        "client-cursor-3",
        "client-cursor-4",
      ]);
    } finally {
      await testContext.resetDatabase();
    }
  });
});
