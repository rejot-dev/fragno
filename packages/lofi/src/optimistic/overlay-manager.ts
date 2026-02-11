import type { AnySchema } from "@fragno-dev/db/schema";
import type {
  LofiAdapter,
  LofiQueryEngineOptions,
  LofiQueryInterface,
  LofiSubmitCommand,
  LofiSubmitCommandDefinition,
  LofiQueryableAdapter,
} from "../types";
import { createLocalHandlerTx } from "../submit/local-handler-tx";
import { buildCommandKey, defaultQueueKey, loadSubmitQueue } from "../submit/queue";
import { InMemoryLofiAdapter } from "../adapters/in-memory/adapter";
import { InMemoryLofiStore } from "../adapters/in-memory/store";
import { StackedLofiAdapter } from "../adapters/stacked/adapter";

type OverlayManagerAdapter = LofiAdapter & LofiQueryableAdapter;

export type OverlayManagerOptions<TContext> = {
  endpointName: string;
  adapter: OverlayManagerAdapter;
  schemas: AnySchema[];
  commands: Array<LofiSubmitCommandDefinition<unknown, TContext>>;
  createCommandContext?: (command: LofiSubmitCommandDefinition<unknown, TContext>) => TContext;
  store?: InMemoryLofiStore;
  queueKey?: string;
  schemaNames?: string[];
};

export class LofiOverlayManager<TContext = unknown> {
  readonly store: InMemoryLofiStore;
  readonly overlayAdapter: InMemoryLofiAdapter;
  readonly stackedAdapter: StackedLofiAdapter;
  private readonly adapter: OverlayManagerAdapter;
  private readonly schemas: AnySchema[];
  private readonly commands: Map<string, LofiSubmitCommandDefinition<unknown, TContext>>;
  private readonly queueKey: string;
  private readonly createCommandContext?: (
    command: LofiSubmitCommandDefinition<unknown, TContext>,
  ) => TContext;
  private readonly localTx: ReturnType<typeof createLocalHandlerTx>;

  constructor(options: OverlayManagerOptions<TContext>) {
    this.adapter = options.adapter;
    this.schemas = options.schemas;
    this.overlayAdapter = new InMemoryLofiAdapter({
      endpointName: options.endpointName,
      schemas: options.schemas,
      ...(options.store ? { store: options.store } : {}),
    });
    this.store = this.overlayAdapter.store;
    this.stackedAdapter = new StackedLofiAdapter({
      base: this.adapter,
      overlay: this.overlayAdapter,
      schemas: options.schemas,
    });
    this.queueKey = options.queueKey ?? defaultQueueKey(options.endpointName);
    this.commands = new Map(options.commands.map((command) => [buildCommandKey(command), command]));
    this.createCommandContext = options.createCommandContext;

    this.localTx = createLocalHandlerTx({
      adapter: this.stackedAdapter,
      schemas: options.schemas,
    });
  }

  createQueryEngine<const T extends AnySchema>(
    schema: T,
    options?: LofiQueryEngineOptions,
  ): LofiQueryInterface<T> {
    return this.overlayAdapter.createQueryEngine(schema, options);
  }

  async rebuild(options?: { queue?: LofiSubmitCommand[]; schemaNames?: string[] }): Promise<void> {
    this.overlayAdapter.reset();
    const queue = options?.queue ?? (await loadSubmitQueue(this.adapter, this.queueKey));
    for (const command of queue) {
      await this.runCommand(command);
    }
  }

  async reset(): Promise<void> {
    this.overlayAdapter.reset();
  }

  async applyCommand(command: LofiSubmitCommand): Promise<void> {
    await this.runCommand(command);
  }

  private async runCommand(command: LofiSubmitCommand): Promise<void> {
    const key = buildCommandKey(command);
    const definition = this.commands.get(key);
    if (!definition) {
      throw new Error(`Unknown sync command: ${key}`);
    }
    const ctx = this.createCommandContext
      ? this.createCommandContext(definition)
      : ({} as TContext);

    await definition.handler({
      input: command.input,
      ctx,
      tx: this.localTx,
    });
  }
}
