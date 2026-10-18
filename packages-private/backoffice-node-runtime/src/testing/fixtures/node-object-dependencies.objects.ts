import { threadId } from "node:worker_threads";

import type { NodeDurableObjectState } from "../../runtime/node-durable-object-state";
import type {
  NodeRuntimeObjectContext,
  NodeRuntimeObjectResolver,
} from "../../runtime/node-runtime-object";

/** Receipt objects expose normal RPC and HTTP handlers without a runtime superclass. */
export function createDependencyReceiptObject({ state }: NodeRuntimeObjectContext) {
  return {
    async fetch(request: Request) {
      const message = await request.text();
      await state.storage.put("receipt", message);
      return new Response(`${request.method}:${message}`);
    },
    async record(message: string) {
      await state.storage.put("receipt", message);
      return { message, threadId };
    },
    async read() {
      return { message: (await state.storage.get<string>("receipt")) ?? null, threadId };
    },
  };
}

type LedgerEnvironment = { receiptBinding: string; prefix: string };

class DependencyLedgerObject {
  readonly #state: NodeDurableObjectState;
  readonly #env: LedgerEnvironment;
  readonly #objects: NodeRuntimeObjectResolver;
  readonly #name: string;

  constructor({
    state,
    env,
    objects,
    name,
  }: {
    state: NodeDurableObjectState;
    env: LedgerEnvironment;
    objects: NodeRuntimeObjectResolver;
    name: string;
  }) {
    this.#state = state;
    this.#env = env;
    this.#objects = objects;
    this.#name = name;
    void state.blockConcurrencyWhile(async () => {
      if (!(await state.storage.get<boolean>("initialized"))) {
        using receipt = objects.get<ReturnType<typeof createDependencyReceiptObject>>(
          env.receiptBinding,
          `${env.prefix}${name}`,
        );
        await receipt.record("initialized in worker");
        await state.storage.put("initialized", true);
      }
    });
  }

  async publish(message: string) {
    using receipt = this.#objects.get<ReturnType<typeof createDependencyReceiptObject>>(
      this.#env.receiptBinding,
      `${this.#env.prefix}${this.#name}`,
    );
    const result = await receipt.record(message);
    await this.#state.storage.put("lastPublished", message);
    return { receipt: result, ledgerThreadId: threadId, name: this.#state.id.name };
  }

  async publishHttp(message: string) {
    using receipt = this.#objects.get<ReturnType<typeof createDependencyReceiptObject>>(
      this.#env.receiptBinding,
      `${this.#env.prefix}${this.#name}`,
    );
    const response = await receipt.fetch(
      new Request("https://receipt.test/message", {
        method: "POST",
        body: message,
      }),
    );
    return await response.text();
  }

  async inspect() {
    using receipt = this.#objects.get<ReturnType<typeof createDependencyReceiptObject>>(
      this.#env.receiptBinding,
      `${this.#env.prefix}${this.#name}`,
    );
    return {
      lastPublished: (await this.#state.storage.get<string>("lastPublished")) ?? null,
      receipt: await receipt.read(),
    };
  }

  async unknownBinding() {
    using receipt = this.#objects.get<ReturnType<typeof createDependencyReceiptObject>>(
      "MISSING",
      "one",
    );
    return await receipt.read();
  }
}

/** Importable factories assemble application dependencies and return ordinary implementation classes. */
export function createDependencyLedgerObject({
  state,
  input,
  objects,
  name,
}: NodeRuntimeObjectContext<LedgerEnvironment>) {
  return new DependencyLedgerObject({ state, env: input, objects, name });
}
