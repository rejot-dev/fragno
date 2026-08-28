import type {
  DurableHookQueueEntry,
  DurableHookQueueOptions,
  DurableHookQueueResponse,
  DurableHookRepository,
} from "./durable-hooks";

type DurableHookCommandSource<TOptions extends DurableHookQueueOptions = DurableHookQueueOptions> =
  {
    getDurableHookQueue(options?: TOptions): Promise<DurableHookQueueResponse>;
    getDurableHook(hookId: string): Promise<DurableHookQueueEntry | null>;
  };

/** Adapts finite Durable Object commands to Backoffice's durable hook repository contract. */
export function createDurableHookRepositoryFromCommands<
  TOptions extends DurableHookQueueOptions = DurableHookQueueOptions,
>(commands: DurableHookCommandSource<TOptions>): DurableHookRepository<TOptions> {
  return {
    getHookQueue: async (options) => await commands.getDurableHookQueue(options),
    getHook: async (hookId) => await commands.getDurableHook(hookId),
  };
}
