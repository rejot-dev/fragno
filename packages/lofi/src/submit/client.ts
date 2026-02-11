import type { AnySchema } from "@fragno-dev/db/schema";
import type {
  LofiAdapter,
  LofiSubmitCommand,
  LofiSubmitCommandDefinition,
  LofiSubmitRequest,
  LofiSubmitResponse,
  LofiQueryableAdapter,
} from "../types";
import type { IndexedDbQueryContext } from "../query/engine";
import { createLocalHandlerTx } from "./local-handler-tx";
import { rebaseSubmitQueue } from "./rebase";
import { buildCommandKey, defaultQueueKey, loadSubmitQueue, storeSubmitQueue } from "./queue";

type InternalDescribeResponse = {
  adapterIdentity?: string;
};

type SubmitClientOptions<TContext> = {
  endpointName: string;
  submitUrl: string;
  internalUrl: string;
  adapter: LofiAdapter &
    LofiQueryableAdapter & {
      createQueryContext: (schemaName: string) => IndexedDbQueryContext;
    };
  schemas: AnySchema[];
  commands: Array<LofiSubmitCommandDefinition<unknown, TContext>>;
  fetch?: typeof fetch;
  cursorKey?: string;
  queueKey?: string;
  conflictResolutionStrategy?: "server" | "disabled";
  createCommandContext?: (command: LofiSubmitCommandDefinition<unknown, TContext>) => TContext;
};

export class LofiSubmitClient<TContext = unknown> {
  private readonly adapter: SubmitClientOptions<TContext>["adapter"];
  private readonly endpointName: string;
  private readonly submitUrl: string;
  private readonly internalUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly cursorKey: string;
  private readonly queueKey: string;
  private readonly conflictResolutionStrategy: "server" | "disabled";
  private readonly commands: Map<string, LofiSubmitCommandDefinition<unknown, TContext>>;
  private readonly createCommandContext?: SubmitClientOptions<TContext>["createCommandContext"];
  private adapterIdentity?: string;
  private readonly localTx: ReturnType<typeof createLocalHandlerTx>;

  constructor(options: SubmitClientOptions<TContext>) {
    this.adapter = options.adapter;
    this.endpointName = options.endpointName;
    this.submitUrl = options.submitUrl;
    this.internalUrl = options.internalUrl;
    const defaultFetch = fetch.bind(globalThis);
    this.fetcher = options.fetch ?? defaultFetch;
    this.cursorKey = options.cursorKey ?? `${options.endpointName}::outbox`;
    this.queueKey = options.queueKey ?? defaultQueueKey(options.endpointName);
    this.conflictResolutionStrategy = options.conflictResolutionStrategy ?? "server";
    this.createCommandContext = options.createCommandContext;
    this.commands = new Map(options.commands.map((command) => [buildCommandKey(command), command]));
    this.localTx = createLocalHandlerTx({
      adapter: options.adapter,
      schemas: options.schemas,
    });
  }

  async queueCommand(options: {
    name: string;
    target: LofiSubmitCommand["target"];
    input: unknown;
    id?: string;
    optimistic?: boolean;
  }): Promise<string> {
    const id = options.id ?? crypto.randomUUID();
    const command: LofiSubmitCommand = {
      id,
      name: options.name,
      target: options.target,
      input: options.input,
    };

    const queue = await loadSubmitQueue(this.adapter, this.queueKey);
    queue.push(command);
    await storeSubmitQueue(this.adapter, this.queueKey, queue);

    if (options.optimistic !== false) {
      await this.runCommand(command);
    }

    return id;
  }

  async submitOnce(options?: { signal?: AbortSignal }): Promise<LofiSubmitResponse> {
    const queue = await loadSubmitQueue(this.adapter, this.queueKey);
    const adapterIdentity = await this.getAdapterIdentity(options?.signal);
    const baseVersionstamp = await this.adapter.getMeta(this.cursorKey);

    const requestId = crypto.randomUUID();
    const request: LofiSubmitRequest = {
      baseVersionstamp: baseVersionstamp ?? undefined,
      requestId,
      conflictResolutionStrategy: this.conflictResolutionStrategy,
      adapterIdentity,
      commands: queue,
    };

    const response = await this.fetcher(this.submitUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: options?.signal,
    });

    if (!response.ok) {
      throw new Error(`Submit request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as LofiSubmitResponse;

    const rebased = await rebaseSubmitQueue({
      adapter: this.adapter,
      entries: payload.entries,
      cursorKey: this.cursorKey,
      confirmedCommandIds: payload.confirmedCommandIds,
      queue,
      replayCommand: async (command) => {
        await this.runCommand(command);
      },
    });

    await storeSubmitQueue(this.adapter, this.queueKey, rebased.queue);
    return payload;
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

  private async getAdapterIdentity(signal?: AbortSignal): Promise<string> {
    if (this.adapterIdentity) {
      return this.adapterIdentity;
    }

    const response = await this.fetcher(this.internalUrl, { signal });
    if (!response.ok) {
      throw new Error(`Internal preflight failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as InternalDescribeResponse;
    if (!payload.adapterIdentity) {
      throw new Error("Internal preflight missing adapterIdentity");
    }

    this.adapterIdentity = payload.adapterIdentity;
    return payload.adapterIdentity;
  }
}
