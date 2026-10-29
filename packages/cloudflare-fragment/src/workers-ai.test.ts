import { describe, expect, test, vi, assert } from "vitest";

import { createWorkersAi, type WorkersAiBinding } from "./workers-ai";

const clairic = "@cf/cloudflare/clairic";

function createWorkersAiWith({
  run = async () => {
    throw new Error("The test runs no model.");
  },
  fetch = async () => {
    throw new Error("The test reads no documentation.");
  },
}: {
  run?: WorkersAiBinding["run"];
  fetch?: typeof globalThis.fetch;
}) {
  return createWorkersAi({ binding: { run }, fetch });
}

/** How the binding answers a failed run when asked for the raw response. */
function workersAiError(internalCode: number, description: string) {
  return Response.json(
    {
      name: "AiError",
      internalCode,
      httpCode: 400,
      message: `AiError: ${description}`,
      description,
    },
    { status: 400 },
  );
}

describe("Workers AI", () => {
  test("a run returns the model's output with the neurons Cloudflare billed for it", async () => {
    const run = vi.fn<WorkersAiBinding["run"]>(async () =>
      Response.json({ answers: { total: { value: 5 } } }, { headers: { "cf-ai-neurons": "1.17" } }),
    );
    const workersAi = createWorkersAiWith({ run });

    await expect(workersAi.run(clairic, { model: "clairic" })).resolves.toEqual({
      status: "completed",
      output: { answers: { total: { value: 5 } } },
      neurons: 1.17,
    });
    expect(run).toHaveBeenCalledWith(clairic, { model: "clairic" }, { returnRawResponse: true });
  });

  test("a model the account cannot run is unavailable, and a rejected run fails", async () => {
    const responses = [
      workersAiError(5007, `No such model ${clairic} or task`),
      workersAiError(5006, "Error: enum bogus not in text,number at '/total/type'"),
      // Without the header, nothing says what the run cost.
      Response.json({ answers: {} }),
    ];
    const workersAi = createWorkersAiWith({ run: async () => responses.shift()! });

    await expect(workersAi.run(clairic, {})).resolves.toEqual({
      status: "unavailable",
      code: 5007,
      message: `No such model ${clairic} or task`,
    });
    await expect(workersAi.run(clairic, {})).resolves.toEqual({
      status: "failed",
      code: 5006,
      message: "Error: enum bogus not in text,number at '/total/type'",
    });
    await expect(workersAi.run(clairic, {})).resolves.toEqual({
      status: "failed",
      code: null,
      message: "Workers AI reported no neuron usage for the run.",
    });
  });

  test("model schemas are read from Cloudflare's documentation without credentials", async () => {
    const input = { type: "object", properties: { state: { type: "string" } } };
    const output = { type: "object", properties: { answers: { type: "object" } } };
    const documentation: Record<string, unknown> = {
      "/workers-ai/models/clairic/schema-input.json": input,
      "/workers-ai/models/clairic/schema-output.json": output,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      assert(!new Headers(init?.headers).has("authorization"));
      const schema = documentation[new URL(String(url)).pathname];
      return schema ? Response.json(schema) : new Response("Not Found", { status: 404 });
    });
    const workersAi = createWorkersAiWith({ fetch });

    await expect(workersAi.modelSchemas(clairic)).resolves.toEqual({
      status: "found",
      input,
      output,
    });
    expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      "https://developers.cloudflare.com/workers-ai/models/clairic/schema-input.json",
      "https://developers.cloudflare.com/workers-ai/models/clairic/schema-output.json",
    ]);
    await expect(workersAi.modelSchemas("@cf/cloudflare/missing")).resolves.toEqual({
      status: "missing",
    });
  });
});
