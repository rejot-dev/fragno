import type { RpcCompatible, RpcStub } from "capnweb";

import type { NodeDurableObjectState } from "./node-durable-object-state";

/** Resolves cross-object capabilities through the host; callers dispose handles with `using`. */
export type NodeRuntimeObjectResolver = {
  get<TObject extends RpcCompatible<TObject>>(binding: string, name: string): RpcStub<TObject>;
};

/** Factories construct application dependencies locally from cloned input and host-backed object access. */
export type NodeRuntimeObjectContext<TInput = null> = {
  id: NodeDurableObjectState["id"];
  name: string;
  state: NodeDurableObjectState;
  input: TInput;
  objects: NodeRuntimeObjectResolver;
  nowEpochMs(this: void): number;
  /** Registers worker-local cleanup, run after admission stops and before storage closes. */
  onShutdown(this: void, cleanup: () => void | Promise<void>): void;
};

/** Object factories are imported in workers, never transferred as closures; RPC-only objects are supported. */
export type NodeRuntimeObjectFactory = (context: NodeRuntimeObjectContext<unknown>) => object;

declare const nodeRuntimeObjectFactory: unique symbol;

/** An importable object factory with its RPC signatures retained only in the type system. */
export type NodeRuntimeObjectDefinition<
  TFactory extends (context: never) => object = (context: never) => object,
> = {
  moduleUrl: string;
  exportName: string;
  input: unknown;
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

/** Declares an importable factory; input is cloned now and again at worker activation, never serialized code. */
export function defineNodeRuntimeObject<TFactory extends (context: never) => object>(
  moduleUrl: URL,
  exportName: string,
  ...input: Parameters<TFactory>[0] extends { input: infer TInput }
    ? null extends TInput
      ? [input?: TInput]
      : [input: TInput]
    : []
): NodeRuntimeObjectDefinition<TFactory>;
export function defineNodeRuntimeObject(
  moduleUrl: URL,
  exportName: string,
  input: unknown = null,
): NodeRuntimeObjectDefinition {
  if (moduleUrl.protocol !== "file:" || exportName.length === 0) {
    throw new Error(
      "NODE_RUNTIME_OBJECT_INVALID_MODULE: expected a file URL and named factory export.",
    );
  }
  let clonedInput: unknown;
  try {
    clonedInput = structuredClone(input);
  } catch (cause) {
    throw new Error("NODE_RUNTIME_OBJECT_INPUT_NOT_CLONEABLE", { cause });
  }
  return {
    moduleUrl: moduleUrl.href,
    exportName,
    input: clonedInput,
  } as NodeRuntimeObjectDefinition;
}
