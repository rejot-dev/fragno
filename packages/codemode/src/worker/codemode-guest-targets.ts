import type { RemoteWorkflowStepScope } from "@fragno-dev/workflows/remote-workflow";
import type {
  WorkflowDuration,
  WorkflowStepConfig,
  WorkflowStepEvent,
  WorkflowStepWorkflowOperation,
} from "@fragno-dev/workflows/workflow";
import { RpcTarget } from "cloudflare:workers";

import { CODEMODE_LIMITS } from "../codemode-limits";
import { codemodeHostCall } from "../transport/codemode-errors";
import type { CodemodePeer } from "../transport/codemode-peer";
import type {
  CodemodeGuestOperation,
  CodemodeHostOperation,
  CodemodeActivation,
} from "../transport/codemode-protocol";

type GuestCallback = (call: CodemodeGuestOperation) => Promise<unknown>;

/** Guest callback handles never outlive their owning step, event subscription, or agent prompt. */
export class CodemodeGuestTargets {
  readonly #callbacks = new Map<number, GuestCallback>();
  #nextId = 0;
  readonly peer: CodemodePeer;

  constructor(peer: CodemodePeer) {
    this.peer = peer;
  }
  register(callback: GuestCallback): number {
    if (this.#callbacks.size >= CODEMODE_LIMITS.maxHandles) {
      throw new Error("CODEMODE_CALLBACK_LIMIT_EXCEEDED");
    }
    const id = ++this.#nextId;
    this.#callbacks.set(id, callback);
    return id;
  }
  release(id: number): void {
    this.#callbacks.delete(id);
  }
  async invoke(call: CodemodeGuestOperation): Promise<unknown> {
    const callback = this.#callbacks.get(call.callbackId);
    if (!callback) {
      throw new Error("CODEMODE_CALLBACK_NOT_FOUND");
    }
    return await callback(call);
  }
  close(): void {
    this.#callbacks.clear();
  }
  create(activation: CodemodeActivation) {
    const dispatchers = Object.fromEntries(
      activation.providers.map((provider) => [
        provider.name,
        new RemoteCodemodeProvider(this.peer, provider),
      ]),
    );
    return {
      dispatchers,
      stepTarget: new RemoteCodemodeStep(this),
      agentTarget:
        activation.kind === "workflow" && activation.agentAvailable
          ? new RemoteCodemodeAgent(this)
          : null,
    };
  }
}

class RemoteCodemodeProvider extends RpcTarget {
  readonly #peer: CodemodePeer;
  readonly #provider: CodemodeActivation["providers"][number];
  constructor(peer: CodemodePeer, provider: CodemodeActivation["providers"][number]) {
    super();
    this.#peer = peer;
    this.#provider = provider;
  }
  async call(tool: string, argsJson: string): Promise<unknown> {
    if (!this.#provider.tools.includes(tool)) {
      throw new Error("CODEMODE_TOOL_NOT_EXPOSED");
    }
    return await this.#peer.call({
      operation: "provider.call",
      provider: this.#provider.name,
      tool,
      argsJson,
    });
  }
}

class RemoteCodemodeTx extends RpcTarget {
  readonly #targets: CodemodeGuestTargets;
  readonly #txId: number;
  readonly #events = new Set<number>();
  #active = true;
  constructor(targets: CodemodeGuestTargets, txId: number) {
    super();
    this.#targets = targets;
    this.#txId = txId;
  }
  #call(operation: CodemodeHostOperation): Promise<unknown> {
    if (!this.#active) {
      throw new Error("REMOTE_WORKFLOW_TX_NOT_FOUND");
    }
    return this.#targets.peer.call(operation);
  }
  async emit(payload: unknown) {
    return await this.#call({ operation: "tx.emit", txId: this.#txId, payload });
  }
  async previousEmissions() {
    return await this.#call({ operation: "tx.previousEmissions", txId: this.#txId });
  }
  async previousConsumedEvents() {
    return await this.#call({ operation: "tx.previousConsumedEvents", txId: this.#txId });
  }
  async workflowServiceCalls(operations: WorkflowStepWorkflowOperation[]) {
    return await this.#call({
      operation: "tx.workflowServiceCalls",
      txId: this.#txId,
      operations: operations.map((operation) =>
        operation.type === "createEvent" ? { ...operation, payload: operation.payload } : operation,
      ),
    });
  }
  async triggerHook(
    intent: Extract<CodemodeHostOperation, { operation: "tx.triggerHook" }>["intent"],
  ) {
    return await this.#call({ operation: "tx.triggerHook", txId: this.#txId, intent });
  }
  async onEvent(
    eventType: string,
    handler: (event: Omit<WorkflowStepEvent, "payload"> & { payload: unknown }) => Promise<void>,
  ) {
    let active = true;
    const callbackId = this.#targets.register(async (call) => {
      if (call.operation !== "callback.event") {
        throw new Error("CODEMODE_CALLBACK_KIND_MISMATCH");
      }
      if (!active || !this.#active) {
        return { deliveryId: call.deliveryId, consumed: false };
      }
      let consumed = false;
      let delivering = true;
      try {
        await handler({
          ...call.event,
          consume() {
            if (!delivering) {
              throw new Error("CODEMODE_EVENT_DELIVERY_ENDED");
            }
            consumed = true;
          },
        });
      } finally {
        delivering = false;
      }
      return { deliveryId: call.deliveryId, consumed: active && this.#active && consumed };
    });
    this.#events.add(callbackId);
    try {
      const subscriptionId = (await this.#call({
        operation: "tx.onEvent",
        txId: this.#txId,
        eventType,
        callbackId,
      })) as number;
      return async () => {
        if (!active) {
          return;
        }
        active = false;
        // Keep the inert callback until step completion to acknowledge already-sent deliveries.
        if (this.#active) {
          await this.#call({ operation: "tx.unsubscribe", txId: this.#txId, subscriptionId });
        }
      };
    } catch (error) {
      this.#targets.release(callbackId);
      this.#events.delete(callbackId);
      throw error;
    }
  }
  close() {
    this.#active = false;
    for (const id of this.#events) {
      this.#targets.release(id);
    }
    this.#events.clear();
  }
}

class RemoteCodemodeStep extends RpcTarget {
  readonly #targets: CodemodeGuestTargets;
  constructor(targets: CodemodeGuestTargets) {
    super();
    this.#targets = targets;
  }
  async do(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    config: WorkflowStepConfig | undefined,
    callback: (
      tx: RemoteCodemodeTx,
      scope: NonNullable<RemoteWorkflowStepScope>,
    ) => Promise<unknown>,
  ) {
    const callbackId = this.#targets.register(async (call) => {
      if (call.operation !== "callback.step") {
        throw new Error("CODEMODE_CALLBACK_KIND_MISMATCH");
      }
      const tx = new RemoteCodemodeTx(this.#targets, call.txId);
      try {
        return await callback(tx, call.scope);
      } finally {
        tx.close();
      }
    });
    try {
      return await codemodeHostCall(() =>
        this.#targets.peer.call({
          operation: "step.do",
          parentScope,
          name,
          config: config ?? null,
          callbackId,
        }),
      );
    } finally {
      this.#targets.release(callbackId);
    }
  }
  async sleep(parentScope: RemoteWorkflowStepScope, name: string, duration: WorkflowDuration) {
    return await codemodeHostCall(() =>
      this.#targets.peer.call({ operation: "step.sleep", parentScope, name, duration }),
    );
  }
  async sleepUntil(parentScope: RemoteWorkflowStepScope, name: string, timestamp: Date | number) {
    return await codemodeHostCall(() =>
      this.#targets.peer.call({ operation: "step.sleepUntil", parentScope, name, timestamp }),
    );
  }
  async waitForEvent(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    options: {
      type: string;
      timeout: WorkflowDuration | undefined;
      onConsume: ((tx: RemoteCodemodeTx, event: unknown) => Promise<void>) | undefined;
    },
  ) {
    const callback = options.onConsume;
    const callbackId = callback
      ? this.#targets.register(async (call) => {
          if (call.operation !== "callback.consume") {
            throw new Error("CODEMODE_CALLBACK_KIND_MISMATCH");
          }
          const tx = new RemoteCodemodeTx(this.#targets, call.txId);
          try {
            await callback(tx, call.event);
            return;
          } finally {
            tx.close();
          }
        })
      : null;
    try {
      return await codemodeHostCall(() =>
        this.#targets.peer.call({
          operation: "step.waitForEvent",
          parentScope,
          name,
          eventType: options.type,
          timeout: options.timeout ?? null,
          callbackId,
        }),
      );
    } finally {
      if (callbackId !== null) {
        this.#targets.release(callbackId);
      }
    }
  }
}

class RemoteCodemodeAgent extends RpcTarget {
  readonly #targets: CodemodeGuestTargets;
  constructor(targets: CodemodeGuestTargets) {
    super();
    this.#targets = targets;
  }
  async prompt(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    input: {
      text: string;
      images:
        | Extract<CodemodeHostOperation, { operation: "agent.prompt" }>["input"]["images"]
        | undefined;
      tools:
        | Extract<CodemodeHostOperation, { operation: "agent.prompt" }>["input"]["tools"]
        | undefined;
    },
    tools: { execute(toolId: string, toolCallId: string, input: unknown): Promise<unknown> } | null,
  ) {
    const callbackId = tools
      ? this.#targets.register(async (call) => {
          if (call.operation !== "callback.agentTool") {
            throw new Error("CODEMODE_CALLBACK_KIND_MISMATCH");
          }
          return await tools.execute(call.toolId, call.toolCallId, call.input);
        })
      : null;
    try {
      return await codemodeHostCall(() =>
        this.#targets.peer.call({
          operation: "agent.prompt",
          parentScope,
          name,
          input: { text: input.text, images: input.images ?? null, tools: input.tools ?? [] },
          callbackId,
        }),
      );
    } finally {
      if (callbackId !== null) {
        this.#targets.release(callbackId);
      }
    }
  }
}
