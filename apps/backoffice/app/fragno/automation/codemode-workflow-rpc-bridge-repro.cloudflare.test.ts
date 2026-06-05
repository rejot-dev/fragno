/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { RpcTarget } from "cloudflare:workers";
import { env } from "cloudflare:workers";

class TestToolDispatcher extends RpcTarget {
  async call(name: string, argsJson?: string): Promise<string> {
    return JSON.stringify({ result: { name, args: argsJson ? JSON.parse(argsJson) : [] } });
  }
}

describe("codemode workflow RPC bridge experiment", () => {
  test("a parent DO can pass an RPC dispatcher into a dynamic DO facet method", async () => {
    const host = env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName("rpc-bridge-parent"));
    const result = await runInDurableObject(host, async (_instance, state) => {
      const worker = env.LOADER.get("codemode-workflow-rpc-bridge-mvp", () => ({
        compatibilityDate: "2026-05-07",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "facet.js",
        modules: {
          "facet.js": `
            import { DurableObject } from "cloudflare:workers";

            export class RpcBridgeFacet extends DurableObject {
              async callTool(dispatcher, input) {
                const responseJson = await dispatcher.call("echo", JSON.stringify([input]));
                const response = JSON.parse(responseJson);
                await this.ctx.storage.put("last", response.result);
                return response.result;
              }

              async fetch() {
                return Response.json(await this.ctx.storage.get("last") ?? null);
              }
            }
          `,
        },
      }));
      const facet = state.facets.get("rpc-bridge-child", () => ({
        class: worker.getDurableObjectClass("RpcBridgeFacet"),
        id: "rpc-bridge-child",
      })) as Fetcher & {
        callTool(dispatcher: TestToolDispatcher, input: unknown): Promise<unknown>;
      };

      const rpcResult = await facet.callTool(new TestToolDispatcher(), { ok: true });
      const storedResponse = await facet.fetch("https://facet.local/");

      return {
        rpcResult,
        stored: await storedResponse.json(),
      };
    });

    expect(result).toMatchInlineSnapshot(`
      {
        "rpcResult": {
          "args": [
            {
              "ok": true,
            },
          ],
          "name": "echo",
        },
        "stored": {
          "args": [
            {
              "ok": true,
            },
          ],
          "name": "echo",
        },
      }
    `);
  });
});
