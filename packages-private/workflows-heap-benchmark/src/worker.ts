import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { createFragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { workflowsSchema } from "@fragno-dev/workflows/schema";
import { defineWorkflow } from "@fragno-dev/workflows/workflow";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

const BENCHMARK_WORKFLOW_NAME = "workflow-step-live-pump-heap-benchmark";
const BENCHMARK_INSTANCE_ID = "benchmark-instance";
const BENCHMARK_START_EVENT_TYPE = "benchmark-start";
const HISTORICAL_SEED_CHUNK_SIZE = 250;

type BenchmarkWorkflowParams = {
  batchCount: number;
  emissionsPerBatch: number;
  payloadBytes: number;
  intervalMs: number;
};

type BenchmarkWorkflowOutput = {
  emittedCount: number;
  emittedPayloadBytes: number;
};

type BenchmarkPrepareInput = BenchmarkWorkflowParams & {
  historicalEmissionCount: number;
};

type WorkflowHeapBenchmarkEnv = {
  WORKFLOW_BENCHMARK: DurableObjectNamespace;
};

const WorkflowStepLivePumpHeapBenchmark = defineWorkflow<
  typeof BENCHMARK_WORKFLOW_NAME,
  BenchmarkWorkflowParams,
  BenchmarkWorkflowOutput
>({ name: BENCHMARK_WORKFLOW_NAME }, async (event, step) => {
  await step.waitForEvent("start benchmark", { type: BENCHMARK_START_EVENT_TYPE });

  return await step.do("emit benchmark batches", async (tx) => {
    const payload = "x".repeat(event.payload.payloadBytes);
    let emittedCount = 0;

    for (let batchIndex = 0; batchIndex < event.payload.batchCount; batchIndex += 1) {
      for (
        let emissionIndex = 0;
        emissionIndex < event.payload.emissionsPerBatch;
        emissionIndex += 1
      ) {
        tx.emit({
          type: "benchmark-emission",
          batchIndex,
          emissionIndex,
          payload,
        });
        emittedCount += 1;
      }

      if (batchIndex + 1 < event.payload.batchCount && event.payload.intervalMs > 0) {
        await delay(event.payload.intervalMs);
      }
    }

    return {
      emittedCount,
      emittedPayloadBytes: emittedCount * event.payload.payloadBytes,
    };
  });
});

const workflows = {
  heapBenchmark: WorkflowStepLivePumpHeapBenchmark,
} as const;

type BenchmarkFragment = ReturnType<typeof createBenchmarkFragment>;

function createBenchmarkFragment(
  databaseAdapter: SqlAdapter,
): ReturnType<typeof createWorkflowsFragment<typeof workflows>> {
  return createWorkflowsFragment(
    {
      workflows,
      runtime: defaultFragnoRuntime,
    },
    {
      databaseAdapter,
      outbox: { enabled: true },
    },
  );
}

export class WorkflowBenchmarkObject {
  readonly #databaseAdapter: SqlAdapter;
  readonly #host: FragmentDurableObjectHost<void, BenchmarkFragment>;
  #fragment: BenchmarkFragment | null = null;

  constructor(state: DurableObjectState, env: WorkflowHeapBenchmarkEnv) {
    this.#databaseAdapter = new SqlAdapter({
      dialect: new DurableObjectDialect({
        ctx: state,
        queryInstrumentation: null,
      }),
      driverConfig: new CloudflareDurableObjectsDriverConfig(),
    });
    this.#host = createFragmentDurableObjectHost({
      name: "Workflow heap benchmark",
      state,
      env,
      createRuntime: () => createBenchmarkFragment(this.#databaseAdapter),
    });

    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/prepare") {
        return jsonResponse(await this.#prepare(parsePrepareInput(await request.json())));
      }
      if (request.method === "POST" && url.pathname === "/run") {
        return jsonResponse(await this.#run());
      }
      if (request.method === "GET" && url.pathname === "/result") {
        return jsonResponse(await this.#result());
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  }

  async #prepare(input: BenchmarkPrepareInput): Promise<unknown> {
    const fragment = this.#getFragment();
    await fragment.callServices(() =>
      fragment.services.createInstance(BENCHMARK_WORKFLOW_NAME, {
        id: BENCHMARK_INSTANCE_ID,
        params: {
          batchCount: input.batchCount,
          emissionsPerBatch: input.emissionsPerBatch,
          payloadBytes: input.payloadBytes,
          intervalMs: input.intervalMs,
        },
      }),
    );
    await this.#host.alarm();

    const status = await fragment.callServices(() =>
      fragment.services.getInstanceStatus(BENCHMARK_WORKFLOW_NAME, BENCHMARK_INSTANCE_ID),
    );
    if (status.status !== "waiting") {
      throw new Error(`Benchmark workflow did not reach its start-event wait: ${status.status}`);
    }

    const instance = await this.#readBenchmarkInstance();
    const payload = {
      type: "historical-benchmark-emission",
      payload: "h".repeat(input.payloadBytes),
    };

    for (
      let chunkStart = 0;
      chunkStart < input.historicalEmissionCount;
      chunkStart += HISTORICAL_SEED_CHUNK_SIZE
    ) {
      const chunkEnd = Math.min(
        chunkStart + HISTORICAL_SEED_CHUNK_SIZE,
        input.historicalEmissionCount,
      );
      const unitOfWork = this.#databaseAdapter.createUnitOfWork(
        workflowsSchema,
        workflowsSchema.name,
        `seed-workflow-emissions-${chunkStart}-${chunkEnd}`,
      );

      for (let sequence = chunkStart; sequence < chunkEnd; sequence += 1) {
        unitOfWork.create("workflow_step_emission", {
          instanceRef: instance.id,
          stepKey: "do:historical benchmark stream",
          executionId: "historical-benchmark-execution",
          epoch: "historical-benchmark-epoch",
          sequence,
          actor: "user",
          payload,
        });
      }

      const mutationResult = await unitOfWork.executeMutations();
      if (!mutationResult.success) {
        throw new Error("Historical benchmark emission seeding encountered a conflict.");
      }
    }

    return {
      workflowName: BENCHMARK_WORKFLOW_NAME,
      instanceId: BENCHMARK_INSTANCE_ID,
      historicalEmissionCount: input.historicalEmissionCount,
      status,
    };
  }

  async #run(): Promise<unknown> {
    const fragment = this.#getFragment();
    await fragment.callServices(() =>
      fragment.services.sendEvent(BENCHMARK_WORKFLOW_NAME, BENCHMARK_INSTANCE_ID, {
        id: "benchmark-start-event",
        type: BENCHMARK_START_EVENT_TYPE,
        payload: null,
      }),
    );
    await this.#host.alarm();

    const status = await fragment.callServices(() =>
      fragment.services.getInstanceStatus(BENCHMARK_WORKFLOW_NAME, BENCHMARK_INSTANCE_ID),
    );
    if (status.status !== "complete") {
      throw new Error(`Benchmark workflow did not complete: ${status.status}`);
    }

    return status;
  }

  async #result(): Promise<unknown> {
    const fragment = this.#getFragment();
    const status = await fragment.callServices(() =>
      fragment.services.getInstanceStatus(BENCHMARK_WORKFLOW_NAME, BENCHMARK_INSTANCE_ID),
    );
    const instance = await this.#readBenchmarkInstance();
    const [emissionCount] = await this.#databaseAdapter
      .createUnitOfWork(workflowsSchema, workflowsSchema.name, "count-benchmark-emissions")
      .find("workflow_step_emission", (builder) =>
        builder
          .whereIndex("idx_workflow_step_emission_instance_createdAt_sequence_id", (expression) =>
            expression("instanceRef", "=", instance.id),
          )
          .selectCount(),
      )
      .executeRetrieve();

    return {
      status,
      persistedEmissionCount: emissionCount,
    };
  }

  async #readBenchmarkInstance() {
    const [instance] = await this.#databaseAdapter
      .createUnitOfWork(workflowsSchema, workflowsSchema.name, "read-benchmark-instance")
      .findFirst("workflow_instance", (builder) =>
        builder.whereIndex("idx_workflow_instance_workflowName_instanceId", (expression) =>
          expression.and(
            expression("workflowName", "=", BENCHMARK_WORKFLOW_NAME),
            expression("instanceId", "=", BENCHMARK_INSTANCE_ID),
          ),
        ),
      )
      .executeRetrieve();

    if (!instance) {
      throw new Error("Benchmark workflow instance is missing.");
    }
    return instance;
  }

  #getFragment(): BenchmarkFragment {
    if (!this.#fragment) {
      throw new Error("Benchmark workflow fragment is not initialized.");
    }
    return this.#fragment;
  }
}

export default {
  async fetch(request: Request, env: WorkflowHeapBenchmarkEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true });
    }

    const benchmarkId = url.searchParams.get("benchmarkId");
    if (!benchmarkId) {
      return jsonResponse({ error: "benchmarkId is required" }, 400);
    }

    const durableObjectId = env.WORKFLOW_BENCHMARK.idFromName(benchmarkId);
    return await env.WORKFLOW_BENCHMARK.get(durableObjectId).fetch(request);
  },
};

function parsePrepareInput(value: unknown): BenchmarkPrepareInput {
  if (!isRecord(value)) {
    throw new Error("Benchmark prepare input must be a JSON object.");
  }

  return {
    historicalEmissionCount: parseInteger(value, "historicalEmissionCount", 0, 100_000),
    batchCount: parseInteger(value, "batchCount", 1, 10_000),
    emissionsPerBatch: parseInteger(value, "emissionsPerBatch", 1, 10_000),
    payloadBytes: parseInteger(value, "payloadBytes", 0, 1_000_000),
    intervalMs: parseInteger(value, "intervalMs", 0, 60_000),
  };
}

function parseInteger(
  value: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const candidate = value[field];
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
