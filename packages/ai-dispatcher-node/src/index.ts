import { createInProcessDispatcher } from "@fragno-dev/dispatcher-node";
import type {
  AiDispatcher,
  AiRunnerTickOptions,
  AiRunnerTickResult,
} from "@fragno-dev/fragment-ai";

export type AiRunnerLike = {
  tick: (
    options?: AiRunnerTickOptions,
  ) => Promise<AiRunnerTickResult | void> | AiRunnerTickResult | void;
};

export type AiDispatcherNode = AiDispatcher & {
  startPolling: () => void;
  stopPolling: () => void;
};

export type AiDispatcherNodeOptions = {
  runner: AiRunnerLike;
  pollIntervalMs?: number;
  tickOptions?: AiRunnerTickOptions;
};

export const createAiDispatcherNode = ({
  runner,
  pollIntervalMs,
  tickOptions,
}: AiDispatcherNodeOptions): AiDispatcherNode => {
  const dispatcher = createInProcessDispatcher({
    pollIntervalMs,
    wake: () => Promise.resolve(runner.tick(tickOptions ?? {})).then(() => undefined),
  });

  return {
    wake: (_payload) => dispatcher.wake(),
    startPolling: dispatcher.startPolling,
    stopPolling: dispatcher.stopPolling,
  };
};
