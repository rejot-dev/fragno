import { workerData, type MessagePort } from "node:worker_threads";

import { RpcTarget } from "capnweb";

import type { GraftNodeAuthorityWindow } from "../graft/graft-node-authority";
import { createNodeMessagePortRpcSession } from "../rpc/node-message-port-rpc";
import {
  createNodeObjectActivation,
  type NodeObjectActivation,
  type NodeObjectActivationActivity,
  type NodeObjectActivationIdleShutdownResult,
  type NodeObjectActivationOptions,
  type NodeObjectActivationShutdownResult,
  type NodeObjectAlarmDelivery,
} from "./node-object-activation";

/** Bootstrap data carries module identity, persistence, and shared clock state, never application RPC values. */
export type NodeObjectWorkerOptions = NodeObjectActivationOptions & { port: MessagePort };

/** Private control RPC shares the worker and object instance used by public fetch and RPC calls. */
export type NodeObjectWorkerControl = {
  getObject(): Promise<RpcTarget>;
  getObjectForOutputScope(outputScopeId: string): Promise<RpcTarget>;
  releaseOutputScope(outputScopeId: string): Promise<void>;
  advanceNodeAuthorityWindow(window: GraftNodeAuthorityWindow): Promise<void>;
  prepareForEvent(): Promise<void>;
  reconcileAlarmWork(reconciliationId: string): Promise<void>;
  deliverAlarm(expectedAlarm: NodeObjectAlarmDelivery, nowEpochMs: number): Promise<void>;
  drainWaitUntil(): Promise<void>;
  readActivationActivity(): Promise<NodeObjectActivationActivity>;
  shutdownIfIdle(idleSinceMonotonicMs: number): Promise<NodeObjectActivationIdleShutdownResult>;
  shutdown(): Promise<NodeObjectActivationShutdownResult | { kind: "initialization-failed" }>;
};

class NodeObjectWorkerApi extends RpcTarget implements NodeObjectWorkerControl {
  readonly #ready: Promise<NodeObjectActivation>;

  constructor(ready: Promise<NodeObjectActivation>) {
    super();
    this.#ready = ready;
  }

  async getObject() {
    return (await this.#ready).target;
  }

  async getObjectForOutputScope(outputScopeId: string) {
    return (await this.#ready).getObjectForOutputScope(outputScopeId);
  }

  async releaseOutputScope(outputScopeId: string) {
    (await this.#ready).releaseOutputScope(outputScopeId);
  }

  async advanceNodeAuthorityWindow(window: GraftNodeAuthorityWindow) {
    (await this.#ready).advanceNodeAuthorityWindow(window);
  }

  async prepareForEvent() {
    await (await this.#ready).prepareForEvent();
  }

  async reconcileAlarmWork(reconciliationId: string) {
    await (await this.#ready).reconcileAlarmWork(reconciliationId);
  }

  async deliverAlarm(expectedAlarm: NodeObjectAlarmDelivery, nowEpochMs: number) {
    await (await this.#ready).deliverAlarm(expectedAlarm, nowEpochMs);
  }

  async drainWaitUntil() {
    await (await this.#ready).drainWaitUntil();
  }

  async readActivationActivity() {
    return (await this.#ready).readActivationActivity();
  }

  async shutdownIfIdle(idleSinceMonotonicMs: number) {
    return await (await this.#ready).shutdownIfIdle(idleSinceMonotonicMs);
  }

  async shutdown() {
    // A failed factory has already closed its storage; shutdown must not mask the original error.
    const activation = await this.#ready.catch(() => null);
    return activation ? await activation.shutdown() : ({ kind: "initialization-failed" } as const);
  }
}

const options = workerData as NodeObjectWorkerOptions;
const ready = createNodeObjectActivation(options);
void ready.catch(() => {});
createNodeMessagePortRpcSession(options.port, new NodeObjectWorkerApi(ready), null);
