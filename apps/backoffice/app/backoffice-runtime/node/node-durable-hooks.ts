import {
  createDurableHooksProcessor,
  type DurableHooksDispatcher,
} from "@fragno-dev/db/dispatchers/node";

import type { BackofficeFragmentHostOperations } from "../runtime-services";
import type { LocalBackofficeDurableHooks } from "./local-runtime";

type CreateDispatcher = NonNullable<BackofficeFragmentHostOperations["createDispatcher"]>;
type DispatcherContext = Parameters<CreateDispatcher>[0];

type RegisteredFragments = Pick<DispatcherContext, "hookFragments" | "instrumentation">;

export type CreateNodeBackofficeDurableHooksOptions = {
  pollIntervalMs?: number;
  onError?: (error: unknown) => void | Promise<void>;
};

/** Records durable hooks for a separate polling process without scheduling local processing. */
export function createExternallyProcessedNodeBackofficeDurableHooks(): LocalBackofficeDurableHooks {
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
export function createNodeBackofficeDurableHooks(
  options: CreateNodeBackofficeDurableHooksOptions = {},
): LocalBackofficeDurableHooks {
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

  const register = async (objectId: string, context: DispatcherContext) => {
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
