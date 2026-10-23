import {
  isRemoteWorkflowSuspension,
  RemoteWorkflowSuspendedError,
  type RemoteWorkflowStepScope,
} from "@fragno-dev/workflows/remote-workflow";
import type { WorkflowDuration, WorkflowStepConfig } from "@fragno-dev/workflows/workflow";
import { RpcTarget, type RpcStub } from "capnweb";
import { z } from "zod";

import {
  codemodeCallbackResultSchema,
  codemodeDurationSchema,
  codemodeHookIntentSchema,
  codemodeStepConfigSchema,
  codemodeStepNameSchema,
  codemodeSuspensionReasonSchema,
  codemodeWorkflowOperationsSchema,
  type CodemodeHost,
  type CodemodeStepCapability,
  type CodemodeStepResult,
  type CodemodeTransactionCapability,
  type CodemodeWorkflowHost,
  type CodemodeWorkflowTransactionHost,
  type CodemodeEventCallback,
  type CodemodeSuspensionReason,
  type CodemodeProviderCapability,
  type CodemodeToolResult,
} from "../execution/codemode-activation-contract";
import { decodeCodemodeError, encodeCodemodeError } from "../execution/codemode-errors";
import type { ResolvedProvider } from "../runtime-api";
import { createCodemodeDispatchers } from "./codemode-tool-dispatcher";

type HostLifetime = {
  closed: boolean;
  pending: Set<Promise<unknown>>;
  revocations: Set<() => void>;
  suspension: CodemodeSuspensionReason | null;
  issuedSuspensions: Set<string>;
};

function assertCodemodeHostOpen(lifetime: HostLifetime) {
  if (lifetime.closed) {
    throw new Error("CODEMODE_HOST_CLOSED");
  }
}
function registerCodemodeRevocation(lifetime: HostLifetime, revoke: () => void) {
  assertCodemodeHostOpen(lifetime);
  lifetime.revocations.add(revoke);
  return function releaseCodemodeCapability() {
    revoke();
    lifetime.revocations.delete(revoke);
  };
}
function trackCodemodeHostCall<T>(lifetime: HostLifetime, operation: () => Promise<T>): Promise<T> {
  assertCodemodeHostOpen(lifetime);
  const task = operation();
  lifetime.pending.add(task);
  void task.then(
    () => lifetime.pending.delete(task),
    () => lifetime.pending.delete(task),
  );
  return task;
}
function unwrapCodemodeCallbackResult(value: unknown) {
  const result = codemodeCallbackResultSchema.parse(value);
  if (result.status === "error") {
    throw decodeCodemodeError(result.error);
  }
  return result.value;
}
function recordCodemodeHostOutcome(lifetime: HostLifetime, value: unknown) {
  if (isRemoteWorkflowSuspension(value)) {
    lifetime.suspension = codemodeSuspensionReasonSchema.parse(value.reason);
    lifetime.issuedSuspensions.add(JSON.stringify(lifetime.suspension));
    return { status: "suspended", reason: lifetime.suspension } as const;
  }
  return { status: "ok", value } as const;
}
async function runCodemodeWorkflowOperation(
  lifetime: HostLifetime,
  operation: () => Promise<unknown>,
): Promise<CodemodeStepResult> {
  try {
    return recordCodemodeHostOutcome(lifetime, await operation());
  } catch (error) {
    if (error instanceof RemoteWorkflowSuspendedError) {
      return recordCodemodeHostOutcome(lifetime, {
        __fragnoRemoteWorkflowSuspended: true,
        reason: error.reason,
      });
    }
    return { status: "error", error: encodeCodemodeError(error) };
  }
}

class CodemodeProviderTarget extends RpcTarget implements CodemodeProviderCapability {
  readonly #lifetime: HostLifetime;
  readonly #provider: CodemodeProviderCapability;
  constructor(lifetime: HostLifetime, provider: CodemodeProviderCapability) {
    super();
    this.#lifetime = lifetime;
    this.#provider = provider;
  }
  call(tool: string, args: unknown[]) {
    return trackCodemodeHostCall(this.#lifetime, () => this.#provider.call(tool, args));
  }
}

/**
 * Enforces exact advertised tool names before forwarding; the original provider never reaches the
 * guest. An unadvertised tool is unknown to the guest, whether or not its host has one by that name.
 */
export function restrictCodemodeProvider(
  provider: CodemodeProviderCapability,
  tools: readonly string[],
): CodemodeProviderCapability {
  const allowedTools = new Set(tools);
  class RestrictedCodemodeProviderTarget extends RpcTarget implements CodemodeProviderCapability {
    async call(tool: string, args: unknown[]): Promise<CodemodeToolResult> {
      if (!allowedTools.has(tool)) {
        return {
          status: "error",
          error: encodeCodemodeError(new Error(`Unknown tool: ${tool}`)),
        };
      }
      return await provider.call(tool, args);
    }
  }
  return new RestrictedCodemodeProviderTarget();
}

// Names are bounded because longer ones name no tool or scope.
/** The scope a guest's `context` handle names; `current` is the run's own scope. */
const codemodeToolCallScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("current") }),
  z.strictObject({ kind: z.literal("org"), orgId: z.string().max(256) }),
  z.strictObject({ kind: z.literal("user"), userId: z.string().max(256) }),
  z.strictObject({ kind: z.literal("project"), projectId: z.string().max(256) }),
]);

/**
 * The payload of `__context.callScoped`, through which the guest API's scoped handles call every
 * tool. Guests can send it themselves, so hosts parse it with this schema: a call that observation
 * rejects must not run either.
 */
export const codemodeScopedCallSchema = z.object({
  scope: codemodeToolCallScopeSchema,
  namespace: z.string().max(256),
  toolName: z.string().max(256),
  args: z.array(z.unknown()),
});

/** A tool call as its guest named it. */
export type CodemodeToolCall = {
  scope: z.infer<typeof codemodeToolCallScopeSchema>;
  provider: string;
  tool: string;
};

/**
 * Wraps one tool call; it must return the call's result for the guest. The input is the tool's
 * first argument, the only one tools read.
 */
export type CodemodeToolCallObserver = (
  call: CodemodeToolCall,
  input: unknown,
  invoke: () => Promise<CodemodeToolResult>,
) => Promise<CodemodeToolResult>;

type CodemodeProviderCall =
  | { kind: "tool"; call: CodemodeToolCall; input: unknown }
  // getCurrentScope only reads the run's scope.
  | { kind: "scope-read" }
  | { kind: "rejected"; error: Error };

function classifyCodemodeProviderCall(
  provider: string,
  tool: string,
  args: unknown[],
): CodemodeProviderCall {
  if (provider !== "__context") {
    return { kind: "tool", call: { scope: { kind: "current" }, provider, tool }, input: args[0] };
  }
  if (tool === "getCurrentScope") {
    return { kind: "scope-read" };
  }
  if (tool !== "callScoped") {
    return { kind: "rejected", error: new Error(`Unknown tool: ${tool}`) };
  }
  const scoped = codemodeScopedCallSchema.safeParse(args[0]);
  if (!scoped.success) {
    return {
      kind: "rejected",
      error: new Error(`Invalid scoped tool call:\n${z.prettifyError(scoped.error)}`),
    };
  }
  return {
    kind: "tool",
    call: { scope: scoped.data.scope, provider: scoped.data.namespace, tool: scoped.data.toolName },
    input: scoped.data.args[0],
  };
}

/**
 * Shows a host's owner every tool call its guest makes, as the call happens. Scoped calls are
 * reported as the tool they name. A call that cannot be reported, such as a malformed scoped call,
 * fails without reaching the host, so every tool that runs is observed. Workflow step operations
 * are not tool calls.
 */
export function observeCodemodeToolCalls(
  host: CodemodeHost,
  observe: CodemodeToolCallObserver,
): CodemodeHost {
  class ObservedCodemodeProviderTarget extends RpcTarget implements CodemodeProviderCapability {
    readonly #name: string;
    readonly #provider: CodemodeProviderCapability;
    constructor(name: string, provider: CodemodeProviderCapability) {
      super();
      this.#name = name;
      this.#provider = provider;
    }
    async call(tool: string, args: unknown[]): Promise<CodemodeToolResult> {
      const invoke = () => this.#provider.call(tool, args);
      const classified = classifyCodemodeProviderCall(this.#name, tool, args);
      if (classified.kind === "rejected") {
        return { status: "error", error: encodeCodemodeError(classified.error) };
      }
      return classified.kind === "tool"
        ? await observe(classified.call, classified.input, invoke)
        : await invoke();
    }
  }
  return {
    capabilities: {
      dispatchers: Object.fromEntries(
        Object.entries(host.capabilities.dispatchers).map(([name, provider]) => [
          name,
          new ObservedCodemodeProviderTarget(name, provider),
        ]),
      ),
      stepTarget: host.capabilities.stepTarget,
    },
    close: () => host.close(),
    settle: () => host.settle(),
  };
}

function createCodemodeTransaction(
  lifetime: HostLifetime,
  source: CodemodeWorkflowTransactionHost,
) {
  const state = { active: true, subscriptions: new Set<() => void>() };
  const release = registerCodemodeRevocation(lifetime, () => {
    state.active = false;
    for (const unsubscribe of state.subscriptions) {
      unsubscribe();
    }
    state.subscriptions.clear();
  });
  class CodemodeTransactionTarget extends RpcTarget implements CodemodeTransactionCapability {
    #call<T>(operation: () => Promise<T>): Promise<T> {
      if (!state.active) {
        throw new Error("REMOTE_WORKFLOW_TX_NOT_FOUND");
      }
      return trackCodemodeHostCall(lifetime, operation);
    }
    emit(payload: unknown) {
      return this.#call(async () => {
        source.emit(payload);
      });
    }
    previousEmissions() {
      return this.#call(() => source.previousEmissions());
    }
    previousConsumedEvents() {
      return this.#call(() => source.previousConsumedEvents());
    }
    workflowServiceCalls(
      operations: Parameters<CodemodeTransactionCapability["workflowServiceCalls"]>[0],
    ) {
      const parsed = codemodeWorkflowOperationsSchema.parse(operations);
      return this.#call(async () => {
        source.workflowServiceCalls(parsed);
      });
    }
    triggerHook(intent: Parameters<CodemodeTransactionCapability["triggerHook"]>[0]) {
      const parsed = codemodeHookIntentSchema.parse(intent);
      return this.#call(async () => {
        source.triggerHook(parsed);
      });
    }
    onEvent(type: string, callback: CodemodeEventCallback) {
      const eventType = codemodeStepNameSchema.parse(type);
      if (typeof callback !== "function") {
        throw new Error("CODEMODE_EVENT_CALLBACK_REQUIRED");
      }
      return this.#call(async () => {
        // Native RPC and Cap'n Web parameters are call-owned. A subscription retains its own copy.
        const retained = (callback as RpcStub<CodemodeEventCallback>).dup();
        let active = true;
        let disposeSource: () => void = () => {};
        let releaseSubscription: (() => void) | null = null;
        const unsubscribe = () => {
          if (!active) {
            return;
          }
          active = false;
          disposeSource();
          retained[Symbol.dispose]();
          state.subscriptions.delete(unsubscribe);
          releaseSubscription?.();
        };
        try {
          releaseSubscription = registerCodemodeRevocation(lifetime, () => {
            if (!active) {
              return;
            }
            active = false;
            disposeSource();
            retained[Symbol.dispose]();
            state.subscriptions.delete(unsubscribe);
          });
          state.subscriptions.add(unsubscribe);
          disposeSource = source.onEvent(eventType, async (event) => {
            if (!active || !state.active || lifetime.closed) {
              return;
            }
            await trackCodemodeHostCall(lifetime, async () => {
              const consumed = z.boolean().parse(
                unwrapCodemodeCallbackResult(
                  await retained({
                    id: event.id,
                    type: event.type,
                    payload: event.payload,
                    timestamp: event.timestamp,
                  }),
                ),
              );
              if (consumed && active && state.active && !lifetime.closed) {
                event.consume();
              }
            });
          });
          return async () => {
            unsubscribe();
          };
        } catch (error) {
          if (releaseSubscription) {
            unsubscribe();
          } else {
            retained[Symbol.dispose]();
          }
          throw error;
        }
      });
    }
  }
  return { target: new CodemodeTransactionTarget(), release };
}

function createCodemodeStep(
  lifetime: HostLifetime,
  source: CodemodeWorkflowHost,
  parentScope: RemoteWorkflowStepScope,
) {
  let active = true;
  const release = registerCodemodeRevocation(lifetime, () => {
    active = false;
  });
  class CodemodeStepTarget extends RpcTarget implements CodemodeStepCapability {
    #call(operation: () => Promise<unknown>) {
      if (!active) {
        throw new Error("CODEMODE_WORKFLOW_SCOPE_NOT_ACTIVE");
      }
      return trackCodemodeHostCall(lifetime, () =>
        runCodemodeWorkflowOperation(lifetime, operation),
      );
    }
    do(
      name: string,
      config: WorkflowStepConfig | undefined,
      callback: Parameters<CodemodeStepCapability["do"]>[2],
    ) {
      const stepName = codemodeStepNameSchema.parse(name);
      const stepConfig = codemodeStepConfigSchema.optional().parse(config);
      if (typeof callback !== "function") {
        throw new Error("WORKFLOW_STEP_CALLBACK_REQUIRED");
      }
      return this.#call(() =>
        source.do(parentScope, stepName, stepConfig, async (sourceTx, scope) => {
          const tx = createCodemodeTransaction(lifetime, sourceTx);
          try {
            const step = createCodemodeStep(lifetime, source, scope);
            try {
              const result = unwrapCodemodeCallbackResult(await callback(tx.target, step.target));
              if (
                isRemoteWorkflowSuspension(result) &&
                !lifetime.issuedSuspensions.has(
                  JSON.stringify(codemodeSuspensionReasonSchema.parse(result.reason)),
                )
              ) {
                throw new Error("CODEMODE_UNISSUED_SUSPENSION");
              }
              return result;
            } finally {
              step.release();
            }
          } finally {
            tx.release();
          }
        }),
      );
    }
    sleep(name: string, duration: WorkflowDuration) {
      const stepName = codemodeStepNameSchema.parse(name);
      const delay = codemodeDurationSchema.parse(duration);
      return this.#call(() => source.sleep(parentScope, stepName, delay));
    }
    sleepUntil(name: string, timestamp: Date | number) {
      const stepName = codemodeStepNameSchema.parse(name);
      const time = z.union([z.date(), z.number()]).parse(timestamp);
      return this.#call(() => source.sleepUntil(parentScope, stepName, time));
    }
    waitForEvent(name: string, options: Parameters<CodemodeStepCapability["waitForEvent"]>[1]) {
      const stepName = codemodeStepNameSchema.parse(name);
      const parsed = z
        .strictObject({
          type: codemodeStepNameSchema,
          timeout: codemodeDurationSchema.optional(),
          onConsume: z
            .custom<NonNullable<typeof options.onConsume>>((value) => typeof value === "function")
            .optional(),
        })
        .parse(options);
      const callback = parsed.onConsume;
      return this.#call(() =>
        source.waitForEvent(parentScope, stepName, {
          type: parsed.type,
          timeout: parsed.timeout,
          onConsume: callback
            ? async (sourceTx, event) => {
                const tx = createCodemodeTransaction(lifetime, sourceTx);
                try {
                  unwrapCodemodeCallbackResult(await callback(tx.target, event));
                } finally {
                  tx.release();
                }
              }
            : undefined,
        }),
      );
    }
  }
  return { target: new CodemodeStepTarget(), release };
}

/** Creates revocable tool and workflow capabilities shared by native Workers RPC and Cap'n Web. */
export function createCodemodeHost(
  providers: ResolvedProvider[],
  workflow: CodemodeWorkflowHost | null,
): CodemodeHost {
  const result = createCodemodeDispatchers(providers);
  if ("error" in result) {
    throw new Error(result.error);
  }
  const lifetime: HostLifetime = {
    closed: false,
    pending: new Set(),
    revocations: new Set(),
    suspension: null,
    issuedSuspensions: new Set(),
  };
  const dispatchers = Object.fromEntries(
    Object.entries(result.dispatchers).map(([name, provider]) => [
      name,
      new CodemodeProviderTarget(lifetime, provider),
    ]),
  );
  return {
    capabilities: {
      dispatchers,
      stepTarget: workflow ? createCodemodeStep(lifetime, workflow, null).target : null,
    },
    async close() {
      if (lifetime.closed) {
        return;
      }
      lifetime.closed = true;
      for (const revoke of lifetime.revocations) {
        revoke();
      }
      lifetime.revocations.clear();
    },
    async settle() {
      while (lifetime.pending.size) {
        await Promise.allSettled(lifetime.pending);
      }
      return lifetime.suspension;
    },
  };
}
