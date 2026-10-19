import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import {
  type BackofficeContextScope,
  backofficeScopeOrganization,
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

function failedCodemodeCompletion(error: unknown, logs: CodemodeLogLine[]): CodemodeRunCompletion {
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
    const drained = await Promise.race([
      host.settle().then(() => true),
      new Promise<boolean>((resolve) => {
        drainTimer = setTimeout(() => {
          resolve(false);
        }, CODEMODE_LIMITS.hostDrainTimeoutMs);
      }),
    ]);
    if (!drained) {
      return failedCodemodeCompletion(
        new CodemodeInterruptedError("CODEMODE_HOST_DRAIN_TIMED_OUT"),
        completion.logs,
      );
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
): Promise<CodemodeRunCompletion> {
  let completion: CodemodeCompletion;
  try {
    completion =
      "remoteExecutor" in env
        ? await env.remoteExecutor(activation, host)
        : await executeCodemodeActivationOnLoader(env, activation, host);
  } catch (error) {
    return failedCodemodeCompletion(error, []);
  }
  return completion.status === "suspended"
    ? failedCodemodeCompletion(new Error("CODEMODE_ACTIVATION_CANNOT_SUSPEND"), completion.logs)
    : completion;
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
  const { actors, scopeRestriction, billingOrganizationId, ...payload } = run;
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
  readonly #scopeOrganizationId: string | null;
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
    this.#scopeOrganizationId = backofficeScopeOrganization(scope)?.orgId ?? null;
    // Cloudflare bills each Dynamic Worker a run loads; a module build only compiles.
    async function billRunStarted(run: CodemodeRunStartedHookPayload, hook: HookContext) {
      if (
        run.billingOrganizationId === null ||
        run.activationKind === "module-build" ||
        !runtime.config.bindings.billing
      ) {
        return;
      }
      await runtime.objects.billing.forOrg(run.billingOrganizationId).commands.recordEvent(
        {
          id: `codemode-run:${run.runId}`,
          scope,
          source: "codemode",
          eventType: "run.started",
          occurredAt: run.startedAt,
          measurements: [{ meter: "codemode.executions", unit: "execution", quantity: 1 }],
          metadata: { runId: run.runId },
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

  async execute(
    activation: CodemodeRunActivation,
    context: CodemodeRunContext,
    host: CodemodeExecutionHost,
  ): Promise<CodemodeExecution> {
    const env = this.#env;
    if (!env) {
      throw new Error("CODEMODE_UNAVAILABLE: this runtime has no codemode executor.");
    }
    const fragment = this.#getFragment();
    const runId = await fragment.callServices(() =>
      fragment.services.startRun(
        activation.kind,
        // A scope's organization pays for its runs; only scopes without one take the caller's choice.
        {
          ...context,
          billingOrganizationId: this.#scopeOrganizationId ?? context.billingOrganizationId,
        },
        new Date(this.#nowEpochMs()),
      ),
    );
    const completion = await executeCodemodeRunActivation(env, activation, host);
    await fragment.callServices(() =>
      fragment.services.finishRun(runId, completion, new Date(this.#nowEpochMs())),
    );
    return { runId, completion };
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

  execute(
    activation: CodemodeRunActivation,
    context: CodemodeRunContext,
    host: CodemodeHost,
  ): Promise<CodemodeExecution> {
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
