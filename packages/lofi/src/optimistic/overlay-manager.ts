import type { AnySchema } from "@fragno-dev/db/schema";
import type {
  LofiAdapter,
  LofiBaseSnapshotOptions,
  LofiBaseSnapshotRow,
  LofiQueryEngineOptions,
  LofiQueryInterface,
  LofiMutation,
  LofiSubmitCommand,
  LofiSubmitCommandDefinition,
} from "../types";
import { createLocalHandlerTx, type LocalHandlerQueryExecutor } from "../submit/local-handler-tx";
import { buildCommandKey, defaultQueueKey, loadSubmitQueue } from "../submit/queue";
import {
  createOverlayQueryEngine,
  executeOverlayRetrievalOperation,
  type OverlayQueryContext,
} from "./overlay-query";
import { OptimisticOverlayStore } from "./overlay-store";

type OverlayManagerAdapter = Pick<LofiAdapter, "getMeta" | "setMeta"> & {
  exportBaseSnapshot: (options?: LofiBaseSnapshotOptions) => Promise<LofiBaseSnapshotRow[]>;
};

export type OverlayManagerOptions<TContext> = {
  endpointName: string;
  adapter: OverlayManagerAdapter;
  schemas: AnySchema[];
  commands: Array<LofiSubmitCommandDefinition<unknown, TContext>>;
  createCommandContext?: (command: LofiSubmitCommandDefinition<unknown, TContext>) => TContext;
  store?: OptimisticOverlayStore;
  queueKey?: string;
  schemaNames?: string[];
};

export class LofiOverlayManager<TContext = unknown> {
  readonly store: OptimisticOverlayStore;
  private readonly adapter: OverlayManagerAdapter;
  private readonly schemas: AnySchema[];
  private readonly commands: Map<string, LofiSubmitCommandDefinition<unknown, TContext>>;
  private readonly queueKey: string;
  private readonly createCommandContext?: (
    command: LofiSubmitCommandDefinition<unknown, TContext>,
  ) => TContext;
  private readonly localTx: ReturnType<typeof createLocalHandlerTx>;
  private readonly schemaNames: string[];

  constructor(options: OverlayManagerOptions<TContext>) {
    this.adapter = options.adapter;
    this.schemas = options.schemas;
    this.store =
      options.store ??
      new OptimisticOverlayStore({
        endpointName: options.endpointName,
        schemas: options.schemas,
      });
    this.queueKey = options.queueKey ?? defaultQueueKey(options.endpointName);
    this.commands = new Map(options.commands.map((command) => [buildCommandKey(command), command]));
    this.createCommandContext = options.createCommandContext;
    this.schemaNames = options.schemaNames ?? options.schemas.map((schema) => schema.name);

    const overlayAdapter = {
      applyMutations: async (mutations: LofiMutation[]) => {
        this.store.applyMutations(mutations);
      },
    };

    const queryExecutor: LocalHandlerQueryExecutor<OverlayQueryContext> = {
      createQueryContext: (schemaName: string): OverlayQueryContext => ({
        endpointName: this.store.endpointName,
        schemaName,
        store: this.store,
        referenceTargets: this.store.referenceTargets,
      }),
      executeRetrievalOperation: async ({ operation, context }) =>
        executeOverlayRetrievalOperation({
          operation: operation as Parameters<
            typeof executeOverlayRetrievalOperation
          >[0]["operation"],
          context,
        }),
    };

    this.localTx = createLocalHandlerTx({
      adapter: overlayAdapter,
      schemas: options.schemas,
      queryExecutor,
    });
  }

  createQueryEngine<const T extends AnySchema>(
    schema: T,
    options?: LofiQueryEngineOptions,
  ): LofiQueryInterface<T> {
    return createOverlayQueryEngine({
      schema,
      store: this.store,
      schemaName: options?.schemaName,
    });
  }

  async rebuild(options?: { queue?: LofiSubmitCommand[]; schemaNames?: string[] }): Promise<void> {
    this.store.clear();
    const baseRows = await this.adapter.exportBaseSnapshot({
      schemaNames: options?.schemaNames ?? this.schemaNames,
    });
    this.store.seedRows(baseRows);

    const queue = options?.queue ?? (await loadSubmitQueue(this.adapter, this.queueKey));
    for (const command of queue) {
      await this.runCommand(command);
    }
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
