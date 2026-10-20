import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import {
  backofficeScopeOrganization,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { CODEMODE_LIMITS } from "@fragno-dev/codemode/codemode-limits";
import type {
  CodemodeCompletion,
  CodemodeHost,
} from "@fragno-dev/codemode/execution/codemode-activation-contract";
import {
  CodemodeInterruptedError,
  encodeCodemodeError,
} from "@fragno-dev/codemode/execution/codemode-errors";
import { executeCodemodeActivation } from "@fragno-dev/codemode/execution/execute-codemode-activation";
import type { CodemodeLogLine } from "@fragno-dev/codemode/runtime-api";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";
import { z } from "zod";

import { decodeCursor, type HookContext } from "@fragno-dev/db";

import {
  requireBackofficeContextScopeFromDurableObjectId,
  type CodemodeObject,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  CODEMODE_AUTOMATION_EVENT_RUN_COMPLETED,
  CODEMODE_AUTOMATION_EVENT_RUN_FAILED,
  CODEMODE_AUTOMATION_EVENT_RUN_STARTED,
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
  type CodemodeRun,
  type CodemodeRunPage,
  type CodemodeRunPageInput,
  type CodemodeRunStartedHookPayload,
} from "@/fragno/codemode/codemode-fragment";
import {
  resolveBackofficeWorkerCompiler,
  type BackofficeCodemodeEnv,
  type LocalBackofficeCodemodeEnv,
} from "@/fragno/codemode/execute";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";

const CODEMODE_RUN_MAX_PAGE_SIZE = 20;

const codemodeRunPageInputSchema = z.discriminatedUnion("page", [
  z.strictObject({
    page: z.literal("first"),
    pageSize: z.number().int().min(1).max(CODEMODE_RUN_MAX_PAGE_SIZE),
  }),
  z.strictObject({ page: z.literal("next"), cursor: z.string().min(1) }),
]);

/** Workers RPC delivers the caller's host methods as stubs whose calls return promises. */
type CodemodeExecutionHost = Omit<CodemodeHost, "close"> & { close(): void | Promise<void> };

function failedCodemodeCompletion(error: unknown, logs: CodemodeLogLine[]): CodemodeCompletion {
  return { status: "failed", error: encodeCodemodeError(error), logs };
}

/** Compiled guests skip compilation; source guests may exceed the bridge limit, as Cloudflare always allowed. */
function codemodeActivationDeadlineMs(activation: CodemodeRunActivation): number {
  if (activation.kind === "compiled") {
    return activation.timeoutMs;
  }
  if (activation.kind === "module-build") {
    return CODEMODE_LIMITS.activationTimeoutMs;
  }
  return CODEMODE_LIMITS.compileTimeoutMs + activation.timeoutMs;
}

/** Runs one guest on the local Worker Loader, then revokes and drains the caller's host. */
async function executeCodemodeActivationOnLoader(
  env: LocalBackofficeCodemodeEnv,
  activation: CodemodeRunActivation,
  host: CodemodeExecutionHost,
): Promise<CodemodeCompletion> {
  const interrupted = new AbortController();
  const deadline = setTimeout(() => {
    interrupted.abort(new CodemodeInterruptedError("CODEMODE_ACTIVATION_TIMED_OUT"));
  }, codemodeActivationDeadlineMs(activation));
  let rejectInterrupted: (error: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  function rejectOnAbort() {
    rejectInterrupted(interrupted.signal.reason);
  }
  interrupted.signal.addEventListener("abort", rejectOnAbort, { once: true });
  let completion: CodemodeCompletion;
  try {
    completion = await Promise.race([
      executeCodemodeActivation(
        activation,
        {
          loader: env.LOADER,
          compile: activation.kind === "compiled" ? null : resolveBackofficeWorkerCompiler(env),
        },
        host.capabilities,
        interrupted.signal,
        (error) => {
          interrupted.abort(error);
        },
      ),
      cancellation,
    ]);
  } catch (error) {
    completion = failedCodemodeCompletion(error, []);
  } finally {
    clearTimeout(deadline);
    interrupted.signal.removeEventListener("abort", rejectOnAbort);
    await host.close();
  }
  // Revocation cannot stop an already-running tool. Bound the wait instead of holding the run open.
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const settled = await Promise.race([
      host.settle().then((suspension) => ({ suspension })),
      new Promise<null>((resolve) => {
        drainTimer = setTimeout(() => {
          resolve(null);
        }, CODEMODE_LIMITS.hostDrainTimeoutMs);
      }),
    ]);
    if (settled === null) {
      return failedCodemodeCompletion(
        new CodemodeInterruptedError("CODEMODE_HOST_DRAIN_TIMED_OUT"),
        completion.logs,
      );
    }
    // The host's retry or wake decision survives a guest RPC response that was lost or overridden.
    if (settled.suspension !== null) {
      return { status: "suspended", reason: settled.suspension, logs: completion.logs };
    }
  } finally {
    if (drainTimer !== null) {
      clearTimeout(drainTimer);
    }
  }
  return completion;
}

/** Execution failures, including interruption, are outcomes to record rather than object errors. */
async function executeCodemodeRunActivation(
  env: BackofficeCodemodeEnv,
  activation: CodemodeRunActivation,
  host: CodemodeExecutionHost,
): Promise<CodemodeCompletion> {
  let completion: CodemodeCompletion;
  try {
    completion =
      "remoteExecutor" in env
        ? await env.remoteExecutor(activation, host)
        : await executeCodemodeActivationOnLoader(env, activation, host);
  } catch (error) {
    return failedCodemodeCompletion(error, []);
  }
  return completion.status === "suspended" && activation.kind !== "workflow"
    ? failedCodemodeCompletion(new Error("CODEMODE_ACTIVATION_CANNOT_SUSPEND"), completion.logs)
    : completion;
}

// Cloudflare runs at most 10 Dynamic Workers at once for one Durable Object.
const CODEMODE_OBJECT_MAX_ACTIVATIONS = 10;

/**
 * Admits guests first come, first served. Callers wait rather than fail: a workflow tick that
 * fails outside a step errors its whole instance.
 */
class CodemodeActivationSlots {
  #available: number;
  readonly #waiting: (() => void)[] = [];

  constructor(size: number) {
    this.#available = size;
  }

  /** Resolves with the slot's release, or null when none opened within timeoutMs. */
  acquire(timeoutMs: number): Promise<(() => void) | null> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#release());
    }
    return new Promise((resolve) => {
      const admit = () => {
        clearTimeout(timer);
        resolve(this.#release());
      };
      const timer = setTimeout(() => {
        this.#waiting.splice(this.#waiting.indexOf(admit), 1);
        resolve(null);
      }, timeoutMs);
      this.#waiting.push(admit);
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
function codemodeRunEvent(
  scope: BackofficeContextScope,
  hook: HookContext,
  run: CodemodeRunStartedHookPayload | CodemodeRunFinishedHookPayload,
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
  const finished = "finishedAt" in run ? run : null;
  const organization = backofficeScopeOrganization(scope);
  return {
    id: hook.hookId.toString(),
    // Automations started by this event inherit the run's ceiling, never a wider one.
    scopeRestriction,
    scope,
    source: CODEMODE_AUTOMATION_SOURCE,
    eventType:
      finished === null
        ? CODEMODE_AUTOMATION_EVENT_RUN_STARTED
        : finished.status === "completed"
          ? CODEMODE_AUTOMATION_EVENT_RUN_COMPLETED
          : CODEMODE_AUTOMATION_EVENT_RUN_FAILED,
    occurredAt: finished?.finishedAt ?? run.startedAt,
    payload,
    actors,
    subject: {
      ...(organization ? { orgId: organization.orgId } : {}),
      ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
      runId: run.runId,
    },
    causation: { kind: "origin" },
  };
}

/** Scope-owned codemode boundary shared by Cloudflare and the SQLite runtime. */
export class InMemoryCodemodeObject extends RpcTarget implements CodemodeObject {
  readonly #host: FragmentDurableObjectHost<void, CodemodeFragment>;
  readonly #env: BackofficeCodemodeEnv | null;
  readonly #nowEpochMs: () => number;
  readonly #slots = new CodemodeActivationSlots(CODEMODE_OBJECT_MAX_ACTIVATIONS);
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
    this.#env = runtime.codemodeEnv;
    this.#nowEpochMs = nowEpochMs;
    const scope = requireBackofficeContextScopeFromDurableObjectId(state.id, "CODEMODE");
    const billing = usageBillingForScope(runtime, scope);
    // Cloudflare bills each Dynamic Worker a run loads; a module build only compiles.
    async function billRunStarted(run: CodemodeRunStartedHookPayload, hook: HookContext) {
      // Old queued deliveries retain their original destination, including retries after an ack was lost.
      const destination =
        "billingOrganizationId" in run
          ? usageBillingForScope(
              runtime,
              run.billingOrganizationId === null
                ? { kind: "system" }
                : { kind: "org", orgId: z.string().parse(run.billingOrganizationId) },
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
    async function ingestRunEvent(
      run: CodemodeRunStartedHookPayload | CodemodeRunFinishedHookPayload,
      hook: HookContext,
    ) {
      // Without Automations there is nowhere to record run history.
      if (!runtime.config.bindings.automations) {
        return;
      }
      // A tick is an internal step of its workflow, and run events that start workflows would loop.
      if (run.activationKind === "workflow") {
        return;
      }
      await runtime.objects.automations
        .for(scope)
        .commands.triggerIngestEvent(codemodeRunEvent(scope, hook, run), {
          propagationContext: hook.capturePropagationContext(),
        });
    }
    this.#host = implementation.createFragmentHost({
      name: "Codemode",
      createRuntime: () =>
        createCodemodeFragment(
          {
            onRunStarted: async function billAndIngestRunStarted(run, hook) {
              await billRunStarted(run, hook);
              await ingestRunEvent(run, hook);
            },
            onRunFinished: ingestRunEvent,
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
    host: CodemodeExecutionHost,
  ): Promise<CodemodeExecution<TActivation>> {
    const env = this.#env;
    if (!env) {
      throw new Error("CODEMODE_UNAVAILABLE: this runtime has no codemode executor.");
    }
    const fragment = this.#getFragment();
    const runId = await fragment.callServices(() =>
      fragment.services.startRun(activation, context, new Date(this.#nowEpochMs())),
    );
    // The run is recorded first, so history shows it running while it waits for a slot.
    const release = await this.#slots.acquire(codemodeActivationDeadlineMs(activation));
    let completion: CodemodeCompletion;
    if (release === null) {
      await host.close();
      completion = failedCodemodeCompletion(
        new CodemodeInterruptedError("CODEMODE_ACTIVATION_SLOT_TIMED_OUT"),
        [],
      );
    } else {
      try {
        completion = await executeCodemodeRunActivation(env, activation, host);
      } finally {
        release();
      }
    }
    await fragment.callServices(() =>
      fragment.services.finishRun(runId, completion, new Date(this.#nowEpochMs())),
    );
    // executeCodemodeRunActivation fails every suspension except a workflow tick's.
    return { runId, completion: completion as CodemodeRunCompletion<TActivation> };
  }

  async getRun(runId: string): Promise<CodemodeRun | null> {
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

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }
}

export class Codemode extends DurableObject<CloudflareEnv> implements CodemodeObject {
  readonly #object: InMemoryCodemodeObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryCodemodeObject(createCloudflareBackofficeObjectContext(state, env));
  }

  execute<TActivation extends CodemodeRunActivation>(
    activation: TActivation,
    context: CodemodeRunContext,
    host: CodemodeHost,
  ): Promise<CodemodeExecution<TActivation>> {
    return this.#object.execute(activation, context, host);
  }

  getRun(runId: string): Promise<CodemodeRun | null> {
    return this.#object.getRun(runId);
  }

  listRuns(input: CodemodeRunPageInput): Promise<CodemodeRunPage> {
    return this.#object.listRuns(input);
  }

  async warm(): Promise<void> {
    await this.#object.warm();
  }

  getDurableHookQueue(options?: DurableHookQueueOptions) {
    return this.#object.getDurableHookQueue(options);
  }

  getDurableHook(hookId: string) {
    return this.#object.getDurableHook(hookId);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}
