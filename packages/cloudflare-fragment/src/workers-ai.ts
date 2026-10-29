/**
 * The part of a Worker's `AI` binding this client uses. The binding's own type only accepts its
 * known model names, so callers cast `env.AI` to this.
 */
export type WorkersAiBinding = {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options: { returnRawResponse: true },
  ): Promise<Response>;
};

/** One run, with the neurons Cloudflare bills for it; failed runs are not billed. */
export type WorkersAiRun =
  | { status: "completed"; output: unknown; neurons: number }
  | { status: "unavailable"; code: number; message: string }
  | { status: "failed"; code: number | null; message: string };

/** A model's input and output JSON Schemas, as Cloudflare's model documentation publishes them. */
export type WorkersAiModelSchemas =
  | { status: "found"; input: Record<string, unknown>; output: Record<string, unknown> }
  | { status: "missing" };

export type WorkersAi = {
  run(model: string, input: Record<string, unknown>): Promise<WorkersAiRun>;
  modelSchemas(model: string): Promise<WorkersAiModelSchemas>;
};

// https://developers.cloudflare.com/workers-ai/platform/errors/
const UNAVAILABLE_MODEL_ERROR_CODES = new Set([
  5007, // No such model
  3042, // Invalid model ID
  5018, // Account not allowed for this model
  3041, // Account not allowed for this model
  3023, // Account blocked
  5016, // Model agreement not accepted
  5035, // Workers Paid plan required
]);

const MODEL_DOCUMENTATION_URL = "https://developers.cloudflare.com/workers-ai/models";

/**
 * Runs models through the binding and reads their schemas from Cloudflare's public model
 * documentation, which needs no credentials. Usage is reported in neurons, the unit Cloudflare
 * bills in, so callers can meter any model without knowing its prices.
 */
export function createWorkersAi({
  binding,
  fetch = globalThis.fetch,
}: {
  binding: WorkersAiBinding;
  /** Reaches Cloudflare's documentation; the global fetch by default. */
  fetch?: typeof globalThis.fetch;
}): WorkersAi {
  /** The documentation names a model `@cf/<author>/<name>` by its last segment. */
  async function readSchema(model: string, direction: "input" | "output") {
    const name = model.split("/").at(-1) ?? model;
    const url = `${MODEL_DOCUMENTATION_URL}/${encodeURIComponent(name)}/schema-${direction}.json`;
    const response = await fetch(url);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Cloudflare's documentation answered ${response.status} for ${url}.`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  return {
    async run(model, input) {
      // A raw response carries the neurons header, and reports errors as a status, not a throw.
      const response = await binding.run(model, input, { returnRawResponse: true });
      if (!response.ok) {
        const error = await readWorkersAiError(response);
        return error.code !== null && UNAVAILABLE_MODEL_ERROR_CODES.has(error.code)
          ? { status: "unavailable", code: error.code, message: error.message }
          : { status: "failed", ...error };
      }
      // The header is the only per-run measure of cost, so a run without it cannot be billed.
      const neurons = Number(response.headers.get("cf-ai-neurons") ?? Number.NaN);
      if (!Number.isFinite(neurons) || neurons < 0) {
        return {
          status: "failed",
          code: null,
          message: "Workers AI reported no neuron usage for the run.",
        };
      }
      return { status: "completed", output: await response.json(), neurons };
    },
    async modelSchemas(model) {
      const [input, output] = await Promise.all([
        readSchema(model, "input"),
        readSchema(model, "output"),
      ]);
      return input && output ? { status: "found", input, output } : { status: "missing" };
    },
  };
}

async function readWorkersAiError(
  response: Response,
): Promise<{ code: number | null; message: string }> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { internalCode?: unknown; description?: unknown };
    return {
      code: typeof body.internalCode === "number" ? body.internalCode : null,
      message: typeof body.description === "string" ? body.description : text,
    };
  } catch {
    return { code: null, message: text || `HTTP ${response.status}` };
  }
}
