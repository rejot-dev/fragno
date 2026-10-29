import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { type BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type {
  CodemodeCompletion,
  CodemodeExecutor,
  CodemodeHost,
} from "@fragno-dev/codemode/execution/codemode-activation-contract";
import {
  CodemodeInterruptedError,
  encodeCodemodeError,
} from "@fragno-dev/codemode/execution/codemode-errors";
import { observeCodemodeToolCalls } from "@fragno-dev/codemode/host/codemode-host-capabilities";
import type { CodemodeLogLine } from "@fragno-dev/codemode/runtime-api";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

import { decodeCursor, type HookContext } from "@fragno-dev/db";

import { reportFinishedCodemodeRuns } from "@/backoffice-runtime/backoffice-telemetry";
import {
  requireBackofficeContextScopeFromDurableObjectId,
  type CodemodeCommands,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  CODEMODE_AUTOMATION_EVENT_RUN_FAILED,
  CODEMODE_AUTOMATION_SOURCE,
} from "@/fragno/backoffice-capabilities/capabilities/codemode";
import { usageBillingForScope } from "@/fragno/billing/usage-billing";
import {
  CODEMODE_RUN_ORDER_INDEX,
  createCodemodeFragment,
  type CodemodeExecution,
  type CodemodeFragment,
  type CodemodeRunActivation,
  type CodemodeRunCompletion,
  type CodemodeRunContext,
  type CodemodeRunFinishedHookPayload,
  type CodemodeRunDetail,
  type CodemodeRunPage,
  type CodemodeRunPageInput,
  type CodemodeRunStartedHookPayload,
} from "@/fragno/codemode/codemode-fragment";
import type { CodemodeRunLease } from "@/fragno/codemode/codemode-object-execute";
import { codemodeToolCallObserver } from "@/fragno/codemode/codemode-tool-call-observer";
import { explainUnloadedSavedModule } from "@/fragno/codemode/saved-module-imports";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

const CODEMODE_RUN_MAX_PAGE_SIZE = 20;

const codemodeRunPageInputSchema = z.discriminatedUnion("page", [
  z.strictObject({
    page: z.literal("first"),
    pageSize: z.number().int().min(1).max(CODEMODE_RUN_MAX_PAGE_SIZE),
  }),
  z.strictObject({ page: z.literal("next"), cursor: z.string().min(1) }),
]);

function failedCodemodeCompletion(error: unknown, logs: CodemodeLogLine[]): CodemodeCompletion {
  return { status: "failed", error: encodeCodemodeError(error), logs };
}

/**
 * Execution failures are outcomes to record rather than object errors. Only a workflow tick keeps
 * a suspension or interruption, because only its runner runs it again.
 */
async function executeCodemodeRunActivation(
  executor: CodemodeExecutor,
  activation: CodemodeRunActivation,
  host: CodemodeHost,
): Promise<CodemodeRunCompletion> {
  let completion: Awaited<ReturnType<CodemodeExecutor>>;
  try {
    completion = await executor(activation, host);
  } catch (error) {
    return failedCodemodeCompletion(error, []);
  }
  if (activation.kind === "workflow") {
    return completion;
  }
  if (completion.status === "interrupted") {
    return failedCodemodeCompletion(new CodemodeInterruptedError(completion.cause), []);
  }
  if (completion.status === "suspended") {
    return failedCodemodeCompletion(
      new Error("CODEMODE_ACTIVATION_CANNOT_SUSPEND"),
      completion.logs,
    );
  }
  if (completion.status === "completed") {
    return completion;
  }
  const explained = explainUnloadedSavedModule(completion.error.message);
  return explained === null
    ? completion
    : { ...completion, error: { ...completion.error, message: explained } };
}

// One scope's share of the bridge: a tenant's burst of runs cannot crowd out other tenants.
const CODEMODE_SCOPE_MAX_ACTIVATIONS = 10;

/**
 * Admits a scope's guests first come, first served. Runs wait rather than fail, because an
 * interactive caller such as an agent's tool call has no one to try it again. Every admitted run
 * ends within its executor's deadline, so every waiter is eventually admitted.
 */
class CodemodeActivationSlots {
  #available: number;
  readonly #waiting: (() => void)[] = [];

  constructor(size: number) {
    this.#available = size;
  }

  /** Resolves with the slot's release once the run may start. */
  acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#release());
    }
    // One object shares one I/O context, so another request may resolve this waiter.
    return new Promise((resolve) => {
      this.#waiting.push(() => {
        resolve(this.#release());
      });
    });
  }

  #release() {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      // A released slot passes straight to the next waiter, so a newcomer cannot overtake it.
      const next = this.#waiting.shift();
      if (next) {
        next();
      } else {
        this.#available += 1;
      }
    };
  }
}

/**
 * A run's actors become the event's actors, so automations attribute it to whoever started the run.
 * The hook id is the event id: a retried delivery ingests the same event again.
 */
function codemodeRunFailedEvent(
  scope: BackofficeContextScope,
  hook: HookContext,
  run: Extract<CodemodeRunFinishedHookPayload, { status: "failed" }>,
): AutomationEvent {
  // Billing is delivered to the payer's Billing object, not published to the scope's automations.
  // Hooks queued before ownership-based billing still carry the old selection.
  const {
    actors,
    scopeRestriction,
    billingOrganizationId: _legacy,
    ...payload
  } = run as typeof run & {
    billingOrganizationId?: string | null;
  };
  return {
    id: hook.hookId.toString(),
    // Automations started by this event inherit the run's ceiling, never a wider one.
    scopeRestriction,
    scope,
    source: CODEMODE_AUTOMATION_SOURCE,
    eventType: CODEMODE_AUTOMATION_EVENT_RUN_FAILED,
    occurredAt: run.finishedAt,
    payload,
    actors,
    subject: { scope, runId: run.runId },
    causation: { kind: "origin" },
  };
}

/** Scope-owned codemode boundary shared by Cloudflare and the SQLite runtime. */
export class CodemodeObject extends RpcTarget implements CodemodeCommands {
  readonly #host: FragmentDurableObjectHost<void, CodemodeFragment>;
  readonly #executor: CodemodeExecutor | null;
  readonly #nowEpochMs: () => number;
  readonly #slots = new CodemodeActivationSlots(CODEMODE_SCOPE_MAX_ACTIVATIONS);
  /** Each admitted run lends its slot to the runs its tool calls start, one at a time. */
  readonly #lentSlots = new Map<string, CodemodeActivationSlots>();
  #fragment: CodemodeFragment | null = null;

  constructor({
    state,
    nowEpochMs,
    runtime,
    implementation,
  }: {
    state: BackofficeObjectState;
    nowEpochMs: () => number;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
  }) {
    super();
    this.#executor = runtime.codemodeExecutor;
    this.#nowEpochMs = nowEpochMs;
    const scope = requireBackofficeContextScopeFromDurableObjectId(state.id, "CODEMODE");
    const billing = usageBillingForScope(runtime, scope);
    // Cloudflare bills each Dynamic Worker a run loads; a module build only compiles.
    async function billRunStarted(run: CodemodeRunStartedHookPayload, hook: HookContext) {
      // Old queued deliveries retain their original destination, including retries after an ack was
      // lost. They predate jurisdictions, so their organization names none.
      const destination =
        "billingOrganizationId" in run
          ? usageBillingForScope(
              runtime,
              run.billingOrganizationId === null
                ? { kind: "system" }
                : {
                    kind: "org",
                    orgId: z.string().parse(run.billingOrganizationId),
                    jurisdiction: null,
                  },
            )
          : billing;
      if (run.activationKind === "module-build" || destination.kind === "system") {
        return;
      }
      await destination.recordEvent(
        {
          id: `codemode-run:${run.runId}`,
          scope,
          source: "codemode",
          eventType: "run.started",
          occurredAt: run.startedAt,
          measurements: [{ meter: "codemode.executions", unit: "execution", quantity: 1 }],
          metadata:
            run.activationKind === "workflow"
              ? { runId: run.runId, workflowInstanceId: run.workflowInstanceId }
              : { runId: run.runId },
        },
        { propagationContext: hook.capturePropagationContext() },
      );
    }
    // Only failures become events; run history and tool calls stay in this object's runs.
    async function ingestRunFailed(run: CodemodeRunFinishedHookPayload, hook: HookContext) {
      if (run.status !== "failed" || !runtime.config.bindings.automations) {
        return;
      }
      // A tick is an internal step of its workflow, and run events that start workflows would loop.
      if (run.activationKind === "workflow") {
        return;
      }
      await runtime.objects.automations
        .for(scope)
        .commands.triggerIngestEvent(codemodeRunFailedEvent(scope, hook, run), {
          propagationContext: hook.capturePropagationContext(),
        });
    }
    this.#host = implementation.createFragmentHost({
      name: "Codemode",
      createRuntime: () =>
        createCodemodeFragment(
          {
            onRunStarted: billRunStarted,
            onRunFinished: reportFinishedCodemodeRuns(
              implementation.hostTelemetry("Codemode"),
              ingestRunFailed,
            ),
          },
          {
            databaseAdapter: implementation.fragmentDatabase.adapters.createAdapter({
              kind: "codemode",
            }),
            transactionInstrumentation: implementation.fragmentDatabase.transactionInstrumentation,
          },
        ),
      onProcessError: (error) => {
        console.error("Codemode hook processor error", error);
      },
    });
    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  #getFragment(): CodemodeFragment {
    if (!this.#fragment) {
      throw new Error("Codemode is unavailable.");
    }
    return this.#fragment;
  }

  async execute<TActivation extends CodemodeRunActivation>(
    activation: TActivation,
    context: CodemodeRunContext,
    host: CodemodeHost,
    lease: CodemodeRunLease,
    redactedResults: readonly string[],
  ): Promise<CodemodeExecution<TActivation>> {
    const executor = this.#executor;
    if (!executor) {
      throw new Error("CODEMODE_UNAVAILABLE: this runtime has no codemode executor.");
    }
    const fragment = this.#getFragment();
    const runId = await fragment.callServices(() =>
      fragment.services.startRun(activation, context, new Date(this.#nowEpochMs())),
    );
    // The run is recorded first, so history shows it running while it waits for a slot. A child
    // waits for its parent's slot instead: when every scope slot holds a parent awaiting its child,
    // waiting for a scope slot would hold both until the parents time out.
    const parentSlot = lease.parentKey === null ? undefined : this.#lentSlots.get(lease.parentKey);
    const release = await (parentSlot ?? this.#slots).acquire();
    this.#lentSlots.set(lease.key, new CodemodeActivationSlots(1));
    // Each call is stored as it starts and again as it settles, so history shows a run's calls
    // while it is still running.
    const recordedHost = observeCodemodeToolCalls(
      host,
      codemodeToolCallObserver(redactedResults, {
        started: (sequence, call, input) =>
          fragment.callServices(() =>
            fragment.services.startToolCall(runId, sequence, call, input),
          ),
        settled: (callId, outcome) =>
          fragment.callServices(() => fragment.services.settleToolCall(callId, outcome)),
      }),
    );
    let completion: CodemodeRunCompletion;
    try {
      completion = await executeCodemodeRunActivation(executor, activation, recordedHost);
    } finally {
      this.#lentSlots.delete(lease.key);
      release();
    }
    await fragment.callServices(() =>
      fragment.services.finishRun(runId, completion, new Date(this.#nowEpochMs())),
    );
    // executeCodemodeRunActivation fails every suspension and interruption except a workflow tick's.
    return { runId, completion: completion as CodemodeRunCompletion<TActivation> };
  }

  async getRun(runId: string): Promise<CodemodeRunDetail | null> {
    const fragment = this.#getFragment();
    return await fragment.callServices(() => fragment.services.getRun(runId));
  }

  async listRuns(input: CodemodeRunPageInput): Promise<CodemodeRunPage> {
    const page = codemodeRunPageInputSchema.parse(input);
    const fragment = this.#getFragment();
    if (page.page === "first") {
      return await fragment.callServices(() => fragment.services.listRuns(page));
    }
    let cursor;
    try {
      cursor = decodeCursor(page.cursor);
    } catch (cause) {
      throw new Error("CODEMODE_RUN_CURSOR_INVALID", { cause });
    }
    if (
      cursor.indexName !== CODEMODE_RUN_ORDER_INDEX ||
      cursor.orderDirection !== "desc" ||
      cursor.pageSize < 1 ||
      cursor.pageSize > CODEMODE_RUN_MAX_PAGE_SIZE
    ) {
      throw new Error("CODEMODE_RUN_CURSOR_INVALID");
    }
    return await fragment.callServices(() => fragment.services.listRuns({ page: "next", cursor }));
  }

  async warm(): Promise<void> {}

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    return await loadDurableHookQueue(this.#getFragment(), options);
  }

  async getDurableHook(hookId: string) {
    return await loadDurableHook(this.#getFragment(), hookId);
  }

  async wakeDurableHooks() {
    await this.#host.wake();
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }
}
