import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { createFragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import type { FragnoId } from "@fragno-dev/db/schema";
import { workflowsSchema } from "@fragno-dev/workflows/schema";
import { createWorkflowStepStartedControlPayload } from "@fragno-dev/workflows/step-emission-control";
import { defineWorkflow } from "@fragno-dev/workflows/workflow";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

const BENCHMARK_WORKFLOW_NAME = "workflow-step-live-pump-heap-benchmark";
const BENCHMARK_INSTANCE_ID = "benchmark-instance";
const BENCHMARK_START_EVENT_TYPE = "benchmark-start";
const HISTORICAL_SEED_CHUNK_SIZE = 250;
const CLEANUP_PAGE_SIZE = 100;
const CLEANUP_STEP_KEY = "do:cleanup benchmark stream";
const CLEANUP_EXECUTION_ID = "cleanup-benchmark-execution";
const CLEANUP_EPOCH = "cleanup-benchmark-epoch";
const PREVIOUS_EMISSIONS_STEP_NAME = "measure previous emissions";
const PREVIOUS_EMISSIONS_STEP_KEY = `do:${PREVIOUS_EMISSIONS_STEP_NAME}`;
const PREVIOUS_EMISSIONS_EXECUTION_ID = "previous-emissions-benchmark-execution";
const PREVIOUS_EMISSIONS_EPOCH = "previous-emissions-benchmark-epoch";
const UNRELATED_STEP_KEY = "do:unrelated benchmark stream";

type BenchmarkWorkload = "stream" | "cleanup" | "previous-emissions";

type BenchmarkWorkflowParams = {
  workload: BenchmarkWorkload;
  historicalEmissionCount: number;
  unrelatedEmissionCount: number;
  replayEmissionCount: number;
  readPreviousEmissions: boolean;
  batchCount: number;
  emissionsPerBatch: number;
  payloadBytes: number;
  intervalMs: number;
};

type BenchmarkWorkflowOutput = {
  emittedCount: number;
  emittedPayloadBytes: number;
  previousEmissionCount: number;
  previousPayloadBytes: number;
};

type WorkflowHeapBenchmarkEnv = {
  WORKFLOW_BENCHMARK: DurableObjectNamespace;
};

function expectedPersistedBenchmarkEmissionCount(params: BenchmarkWorkflowParams): number {
  if (params.workload === "previous-emissions") {
    return (
      params.unrelatedEmissionCount +
      params.replayEmissionCount +
      (params.unrelatedEmissionCount > 0 ? 1 : 0) +
      (params.replayEmissionCount > 0 ? 1 : 0)
    );
  }
  return params.historicalEmissionCount;
}

const WorkflowStepLivePumpHeapBenchmark = defineWorkflow<
  typeof BENCHMARK_WORKFLOW_NAME,
  BenchmarkWorkflowParams,
  BenchmarkWorkflowOutput
>({ name: BENCHMARK_WORKFLOW_NAME }, async (event, step) => {
  await step.waitForEvent("start benchmark", { type: BENCHMARK_START_EVENT_TYPE });

  if (event.payload.workload === "previous-emissions") {
    return await step.do(PREVIOUS_EMISSIONS_STEP_NAME, async (tx) => {
      const previousEmissions = event.payload.readPreviousEmissions
        ? await tx.previousEmissions()
        : [];
      const userEmissions = previousEmissions.filter((emission) => emission.actor === "user");
      const previousPayloadBytes = userEmissions.reduce((total, emission) => {
        const payload = emission.payload as { payload: string };
        return total + payload.payload.length;
      }, 0);

      return {
        emittedCount: 0,
        emittedPayloadBytes: 0,
        previousEmissionCount: userEmissions.length,
        previousPayloadBytes,
      };
    });
  }

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
      previousEmissionCount: 0,
      previousPayloadBytes: 0,
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
      dialect: new DurableObjectDialect({ ctx: state, queryInstrumentation: null }),
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
      if (request.method === "POST" && url.pathname === "/cleanup/start") {
        return jsonResponse(await this.#startCleanup());
      }
      if (request.method === "POST" && url.pathname === "/cleanup/page") {
        return jsonResponse(await this.#runCleanupPage());
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

  async #prepare(input: BenchmarkWorkflowParams): Promise<unknown> {
    const fragment = this.#getFragment();
    await fragment.callServices(() =>
      fragment.services.createInstance(BENCHMARK_WORKFLOW_NAME, {
        id: BENCHMARK_INSTANCE_ID,
        params: {
          workload: input.workload,
          historicalEmissionCount: input.historicalEmissionCount,
          unrelatedEmissionCount: input.unrelatedEmissionCount,
          replayEmissionCount: input.replayEmissionCount,
          readPreviousEmissions: input.readPreviousEmissions,
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
    const payload = { type: "benchmark-history-emission", payload: "h".repeat(input.payloadBytes) };

    if (input.workload === "previous-emissions") {
      await this.#seedBenchmarkEmissions(instance.id, {
        label: "unrelated",
        count: input.unrelatedEmissionCount,
        stepKey: UNRELATED_STEP_KEY,
        executionId: "unrelated-benchmark-execution",
        epoch: "unrelated-benchmark-epoch",
        includeStartedControl: input.unrelatedEmissionCount > 0,
        payload,
      });
      await this.#seedBenchmarkEmissions(instance.id, {
        label: "selected-replay-epoch",
        count: input.replayEmissionCount,
        stepKey: PREVIOUS_EMISSIONS_STEP_KEY,
        executionId: PREVIOUS_EMISSIONS_EXECUTION_ID,
        epoch: PREVIOUS_EMISSIONS_EPOCH,
        includeStartedControl: input.replayEmissionCount > 0,
        payload,
      });
    } else {
      await this.#seedBenchmarkEmissions(instance.id, {
        label: input.workload,
        count: input.historicalEmissionCount,
        stepKey: input.workload === "cleanup" ? CLEANUP_STEP_KEY : "do:historical benchmark stream",
        executionId:
          input.workload === "cleanup" ? CLEANUP_EXECUTION_ID : "historical-benchmark-execution",
        epoch: input.workload === "cleanup" ? CLEANUP_EPOCH : "historical-benchmark-epoch",
        includeStartedControl: false,
        payload,
      });
    }

    return {
      workload: input.workload,
      workflowName: BENCHMARK_WORKFLOW_NAME,
      instanceId: BENCHMARK_INSTANCE_ID,
      historicalEmissionCount: input.historicalEmissionCount,
      unrelatedEmissionCount: input.unrelatedEmissionCount,
      replayEmissionCount: input.replayEmissionCount,
      readPreviousEmissions: input.readPreviousEmissions,
      status,
    };
  }

  async #run(): Promise<unknown> {
    const fragment = this.#getFragment();
    const instance = await this.#readBenchmarkInstance();
    const params = instance.params as BenchmarkWorkflowParams;

    if (params.workload === "cleanup") {
      throw new Error("Cleanup benchmarks must use the cleanup start and page endpoints.");
    }

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

    const measuredEmissionCount =
      params.workload === "previous-emissions" ? 0 : params.batchCount * params.emissionsPerBatch;
    const expectedBatches = Math.ceil((measuredEmissionCount + 2) / CLEANUP_PAGE_SIZE);
    for (let pass = 0; pass < expectedBatches; pass += 1) {
      await this.#host.alarm();
    }
    const persistedEmissionCount = await this.#countBenchmarkEmissions(instance.id, params);
    const expectedPersistedEmissionCount = expectedPersistedBenchmarkEmissionCount(params);
    if (persistedEmissionCount !== expectedPersistedEmissionCount) {
      throw new Error(
        `Benchmark cleanup left ${persistedEmissionCount} emissions; ` +
          `expected ${expectedPersistedEmissionCount}.`,
      );
    }
    return status;
  }

  async #startCleanup(): Promise<unknown> {
    const fragment = this.#getFragment();
    const instance = await this.#readBenchmarkInstance();
    const params = instance.params as BenchmarkWorkflowParams;
    if (params.workload !== "cleanup") {
      throw new Error("Streaming benchmarks cannot start cleanup directly.");
    }

    await fragment.inContext(async function () {
      await this.handlerTx()
        .mutate(({ forSchema }) => {
          forSchema(workflowsSchema).triggerHook("onWorkflowStepEmissionsCleanup", {
            workflowName: BENCHMARK_WORKFLOW_NAME,
            instanceId: BENCHMARK_INSTANCE_ID,
            instanceRef: instance.id.toString(),
            stepKey: CLEANUP_STEP_KEY,
            epoch: CLEANUP_EPOCH,
            progress: null,
          });
        })
        .execute();
    });
    return {
      workload: params.workload,
      cleanupBatches: Math.max(1, Math.ceil(params.historicalEmissionCount / CLEANUP_PAGE_SIZE)),
    };
  }

  async #runCleanupPage(): Promise<unknown> {
    await this.#host.alarm();
    return { processed: true };
  }

  async #result(): Promise<unknown> {
    const fragment = this.#getFragment();
    const status = await fragment.callServices(() =>
      fragment.services.getInstanceStatus(BENCHMARK_WORKFLOW_NAME, BENCHMARK_INSTANCE_ID),
    );
    const instance = await this.#readBenchmarkInstance();
    const params = instance.params as BenchmarkWorkflowParams;

    return {
      workload: params.workload,
      status,
      persistedEmissionCount: await this.#countBenchmarkEmissions(instance.id, params),
    };
  }

  async #countBenchmarkEmissions(
    instanceId: FragnoId,
    params: BenchmarkWorkflowParams,
  ): Promise<number> {
    const [emissionCount] = await this.#databaseAdapter
      .createUnitOfWork(workflowsSchema, workflowsSchema.name, "count-benchmark-emissions")
      .find("workflow_step_emission", (builder) =>
        params.workload === "cleanup"
          ? builder
              .whereIndex(
                "idx_workflow_step_emission_instance_step_epoch_createdAt_sequence_id",
                (expression) =>
                  expression.and(
                    expression("instanceRef", "=", instanceId),
                    expression("stepKey", "=", CLEANUP_STEP_KEY),
                    expression("epoch", "=", CLEANUP_EPOCH),
                  ),
              )
              .selectCount()
          : builder
              .whereIndex(
                "idx_workflow_step_emission_instance_createdAt_sequence_id",
                (expression) => expression("instanceRef", "=", instanceId),
              )
              .selectCount(),
      )
      .executeRetrieve();
    return emissionCount;
  }

  async #seedBenchmarkEmissions(
    instanceId: FragnoId,
    options: {
      label: string;
      count: number;
      stepKey: string;
      executionId: string;
      epoch: string;
      includeStartedControl: boolean;
      payload: { type: string; payload: string };
    },
  ): Promise<void> {
    for (let chunkStart = 0; chunkStart < options.count; chunkStart += HISTORICAL_SEED_CHUNK_SIZE) {
      const chunkEnd = Math.min(chunkStart + HISTORICAL_SEED_CHUNK_SIZE, options.count);
      const unitOfWork = this.#databaseAdapter.createUnitOfWork(
        workflowsSchema,
        workflowsSchema.name,
        `seed-${options.label}-emissions-${chunkStart}-${chunkEnd}`,
      );

      if (options.includeStartedControl && chunkStart === 0) {
        unitOfWork.create("workflow_step_emission", {
          instanceRef: instanceId,
          stepKey: options.stepKey,
          executionId: options.executionId,
          epoch: options.epoch,
          sequence: 0,
          actor: "system",
          payload: createWorkflowStepStartedControlPayload(),
        });
      }

      const sequenceOffset = options.includeStartedControl ? 1 : 0;
      for (let emissionIndex = chunkStart; emissionIndex < chunkEnd; emissionIndex += 1) {
        unitOfWork.create("workflow_step_emission", {
          instanceRef: instanceId,
          stepKey: options.stepKey,
          executionId: options.executionId,
          epoch: options.epoch,
          sequence: emissionIndex + sequenceOffset,
          actor: "user",
          payload: options.payload,
        });
      }

      const mutationResult = await unitOfWork.executeMutations();
      if (!mutationResult.success) {
        throw new Error(`Benchmark ${options.label} emission seeding encountered a conflict.`);
      }
    }
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

function parsePrepareInput(value: unknown): BenchmarkWorkflowParams {
  if (!isRecord(value)) {
    throw new Error("Benchmark prepare input must be a JSON object.");
  }

  if (
    value["workload"] !== "stream" &&
    value["workload"] !== "cleanup" &&
    value["workload"] !== "previous-emissions"
  ) {
    throw new Error("Benchmark workload must be stream, cleanup, or previous-emissions.");
  }

  return {
    workload: value["workload"],
    historicalEmissionCount: parseInteger(value, "historicalEmissionCount", 0, 100_000),
    unrelatedEmissionCount: parseInteger(value, "unrelatedEmissionCount", 0, 100_000),
    replayEmissionCount: parseInteger(value, "replayEmissionCount", 0, 100_000),
    readPreviousEmissions: parseBoolean(value, "readPreviousEmissions"),
    batchCount: parseInteger(value, "batchCount", 1, 10_000),
    emissionsPerBatch: parseInteger(value, "emissionsPerBatch", 1, 10_000),
    payloadBytes: parseInteger(value, "payloadBytes", 0, 1_000_000),
    intervalMs: parseInteger(value, "intervalMs", 0, 60_000),
  };
}

function parseBoolean(value: Record<string, unknown>, field: string): boolean {
  const candidate = value[field];
  if (typeof candidate !== "boolean") {
    throw new Error(`Benchmark ${field} must be a boolean.`);
  }
  return candidate;
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
