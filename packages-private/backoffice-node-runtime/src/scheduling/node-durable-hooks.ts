import type { FragmentDurableObjectHostOperations } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import {
  createDurableHooksProcessor,
  type DurableHooksDispatcher,
} from "@fragno-dev/db/dispatchers/node";

type CreateDispatcher<TEnv> = NonNullable<
  FragmentDurableObjectHostOperations<TEnv>["createDispatcher"]
>;
type DispatcherContext<TEnv> = Parameters<CreateDispatcher<TEnv>>[0];

type RegisteredFragments = Pick<DispatcherContext<unknown>, "hookFragments" | "instrumentation">;

/** Durable hook lifecycle supplied to each local Backoffice object. */
export type NodeBackofficeDurableHooks<TEnv> = {
  createFragmentHostOperations(objectId: string): FragmentDurableObjectHostOperations<TEnv> | null;
  unregisterObject(objectId: string): Promise<void>;
  cleanup(): Promise<void>;
};

export type CreateNodeBackofficeDurableHooksOptions = {
  pollIntervalMs?: number;
  onError?: (error: unknown) => void | Promise<void>;
};

/** Records durable hooks for a separate polling process without scheduling local processing. */
export function createExternallyProcessedNodeBackofficeDurableHooks<
  TEnv,
>(): NodeBackofficeDurableHooks<TEnv> {
  return {
    createFragmentHostOperations() {
      return {
        createDispatcher() {
          return {
            initialize: async () => {},
            notify: async () => {},
            alarm: async () => {},
          };
        },
      };
    },
    async unregisterObject() {},
    async cleanup() {},
  };
}

/** Maintains one polling Fragno hook processor across the local objects active in this process. */
export function createNodeBackofficeDurableHooks<TEnv>(
  options: CreateNodeBackofficeDurableHooksOptions = {},
): NodeBackofficeDurableHooks<TEnv> {
  const registrations = new Map<string, RegisteredFragments>();
  let dispatcher: DurableHooksDispatcher | null = null;
  let rebuild = Promise.resolve();
  let rebuildQueued = false;
  let requestedRevision = 0;
  let appliedRevision = 0;
  let closed = false;

  const reportError =
    options.onError ??
    ((error: unknown) => {
      console.error("Node Backoffice durable hook processor failed", error);
    });

  const rebuildDispatcher = async () => {
    requestedRevision += 1;
    if (!rebuildQueued) {
      rebuildQueued = true;
      rebuild = rebuild
        .catch(() => {})
        .then(async () => {
          try {
            while (appliedRevision < requestedRevision) {
              const revision = requestedRevision;
              dispatcher?.stopPolling();
              dispatcher = null;

              const activeRegistrations = [...registrations.values()];
              if (activeRegistrations.length > 0) {
                const instrumentation = activeRegistrations.find(
                  (registration) => registration.instrumentation,
                )?.instrumentation;
                const nextDispatcher = createDurableHooksProcessor(
                  activeRegistrations.flatMap((registration) => [...registration.hookFragments]),
                  {
                    pollIntervalMs: options.pollIntervalMs,
                    onError: reportError,
                    instrumentation,
                  },
                );
                dispatcher = nextDispatcher;
                nextDispatcher.startPolling();
                // Do not wake while fragment hosts are registering: a hook can initialize another
                // local object whose registration waits for this rebuild to finish.
              }

              appliedRevision = revision;
            }
          } finally {
            rebuildQueued = false;
          }
        });
    }
    await rebuild;
  };

  const register = async (objectId: string, context: DispatcherContext<TEnv>) => {
    if (closed) {
      throw new Error("Cannot register durable hooks after the Node runtime has closed.");
    }
    registrations.set(objectId, {
      hookFragments: context.hookFragments,
      instrumentation: context.instrumentation,
    });
    await rebuildDispatcher();
  };

  return {
    createFragmentHostOperations(objectId) {
      return {
        createDispatcher(context) {
          return {
            initialize: async () => {
              await register(objectId, context);
            },
            notify: async (notifyContext) => {
              await rebuild;
              await dispatcher?.notify(notifyContext);
            },
            alarm: async () => {
              await rebuild;
              await dispatcher?.wake();
            },
          };
        },
      };
    },
    async unregisterObject(objectId) {
      if (registrations.delete(objectId)) {
        await rebuildDispatcher();
      }
    },
    async cleanup() {
      await rebuild;
      const closingDispatcher = dispatcher;
      dispatcher = null;
      closed = true;
      closingDispatcher?.stopPolling();
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 0);
      });
      await closingDispatcher?.waitForIdle();
      registrations.clear();
    },
  };
}
