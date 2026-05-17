import { WorkflowsLogger } from "./debug-log";
import type { WorkflowStepEmission } from "./runner/step-live-pump";

export type WorkflowStepEmissionStream<TMessage> = {
  write(message: TMessage): void | Promise<void>;
  onAbort(listener: () => void | Promise<void>): void;
};

export type WorkflowStepEmissionStreamBus<TMessage> = {
  observe(handler: (message: WorkflowStepEmission<TMessage>) => void | Promise<void>): () => void;
};

export type WorkflowStepEmissionStreamOptions<TMessage> = {
  stream: WorkflowStepEmissionStream<TMessage>;
  emissionBus: WorkflowStepEmissionStreamBus<TMessage>;
  initialEmissions?: Iterable<TMessage>;
  timeoutMs?: number | null;
  isTerminalEmission?: (message: TMessage) => boolean;
  onWriteError?: (error: unknown) => void | Promise<void>;
};

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const getEmissionType = (message: unknown): string => {
  if (typeof message === "object" && message !== null && "type" in message) {
    const type = (message as { type?: unknown }).type;
    if (typeof type === "string") {
      return type;
    }
  }
  return typeof message;
};

/**
 * Stream workflow step emissions to a response-like stream.
 *
 * Observer callbacks intentionally do not await stream writes. A slow HTTP
 * consumer should not be able to block the workflow runner while it is flushing
 * step emissions. Writes are still serialized internally so consumers receive
 * frames in the same order they were enqueued.
 */
export async function streamWorkflowStepEmissions<TMessage>({
  stream,
  emissionBus,
  initialEmissions = [],
  timeoutMs = null,
  isTerminalEmission,
  onWriteError,
}: WorkflowStepEmissionStreamOptions<TMessage>): Promise<void> {
  const streamFinished = createDeferred();
  let isStreaming = true;
  let writeTail = Promise.resolve();
  let unsubscribe = () => {};
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const finishStream = () => {
    if (!isStreaming) {
      return;
    }
    WorkflowsLogger.debug("workflow step emission stream finish");
    isStreaming = false;
    streamFinished.resolve();
  };

  const reportWriteError = async (error: unknown) => {
    try {
      await onWriteError?.(error);
    } catch {
      // A write failure is already terminal for the stream. Avoid surfacing a
      // secondary unhandled rejection from diagnostic hooks.
    } finally {
      finishStream();
    }
  };

  const enqueueWrite = (message: TMessage, source: string) => {
    writeTail = writeTail
      .then(async () => {
        if (!isStreaming) {
          return;
        }
        await stream.write(message);
        if (isTerminalEmission?.(message)) {
          finishStream();
        }
      })
      .catch((error: unknown) => {
        WorkflowsLogger.warn("workflow step emission stream write failed", () => ({
          source,
          emissionType: getEmissionType(message),
          error: error instanceof Error ? error.message : String(error),
        }));
        void reportWriteError(error);
      });
  };

  try {
    stream.onAbort(finishStream);

    for (const message of initialEmissions) {
      enqueueWrite(message, "initial");
    }

    unsubscribe = emissionBus.observe((message: WorkflowStepEmission<TMessage>) => {
      WorkflowsLogger.debug("workflow step emission stream observed emission", () => ({
        stepKey: message.stepKey,
        epoch: message.epoch,
        sequence: message.sequence,
        actor: message.actor,
        emissionType: getEmissionType(message.payload),
      }));
      enqueueWrite(message.payload, "emission");
    });

    if (timeoutMs !== null && timeoutMs !== undefined) {
      timeoutId = setTimeout(finishStream, timeoutMs);
      timeoutId.unref?.();
    }

    await streamFinished.promise;
  } finally {
    finishStream();
    unsubscribe();
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
