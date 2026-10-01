import type { RpcStub } from "capnweb";

import type { BackofficeDurableObjectState } from "./local-durable-objects";

/** Object handlers and alarms share this state inside their dedicated worker thread. */
export type NodeRuntimeObjectContext = {
  id: DurableObjectId;
  name: string;
  state: BackofficeDurableObjectState;
  nowEpochMs(this: void): number;
};

/** Object factories are imported in workers, never transferred as closures. */
export type NodeRuntimeObjectFactory = (context: NodeRuntimeObjectContext) => {
  fetch(request: Request): Response | Promise<Response>;
};

declare const nodeRuntimeObjectFactory: unique symbol;

/** An importable object factory with its RPC signatures retained only in the type system. */
export type NodeRuntimeObjectDefinition<
  TFactory extends NodeRuntimeObjectFactory = NodeRuntimeObjectFactory,
> = {
  moduleUrl: string;
  exportName: string;
  readonly [nodeRuntimeObjectFactory]: TFactory;
};

/** Binding definitions identify modules which must also be importable by Node workers. */
export type NodeRuntimeObjectBindings = Record<string, NodeRuntimeObjectDefinition>;

type NodeRuntimeObjectFor<TDefinition extends NodeRuntimeObjectDefinition> = ReturnType<
  TDefinition[typeof nodeRuntimeObjectFactory]
>;
type NodeRuntimePrivateObjectKeys<TObject> = {
  [K in keyof TObject]: K extends "alarm" | "then"
    ? K
    : TObject[K] extends (...args: never[]) => unknown
      ? never
      : K;
}[keyof TObject];

/** Cap'n Web stubs expose callable handlers, never the object's alarm handler or instance fields. */
export type NodeRuntimeObjectStub<TDefinition extends NodeRuntimeObjectDefinition> = Omit<
  RpcStub<NodeRuntimeObjectFor<TDefinition>>,
  NodeRuntimePrivateObjectKeys<NodeRuntimeObjectFor<TDefinition>>
>;

/** Declares an object module without evaluating or serializing its factory in the calling thread. */
export function defineNodeRuntimeObject<TFactory extends NodeRuntimeObjectFactory>(
  moduleUrl: URL,
  exportName: string,
): NodeRuntimeObjectDefinition<TFactory> {
  if (moduleUrl.protocol !== "file:" || exportName.length === 0) {
    throw new Error(
      "NODE_RUNTIME_OBJECT_INVALID_MODULE: expected a file URL and named factory export.",
    );
  }
  return { moduleUrl: moduleUrl.href, exportName } as NodeRuntimeObjectDefinition<TFactory>;
}
