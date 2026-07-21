import type {
  PersistedCollectionCoordinator,
  ProtocolEnvelope,
} from "@tanstack/db-sqlite-persistence-core";

import type { StreamConsumerMode } from "../consumer/durable-stream-consumer";

type CoordinatedConsumerRuntimeOptions = {
  coordinator?: PersistedCollectionCoordinator;
  collectionId: string;
  leadershipPollIntervalMs?: number;
  startConsumer(mode: StreamConsumerMode): boolean;
  onMessage(message: ProtocolEnvelope<unknown>): void | Promise<void>;
  onError(error: unknown): void;
};

/**
 * Owns leader election observation and decides which browser context may start the stream consumer.
 * Stream execution and checkpoint handling remain explicit callbacks owned by the session runtime.
 */
export class CoordinatedConsumerRuntime {
  readonly #options: CoordinatedConsumerRuntimeOptions;
  readonly #ownerId: string;
  #requestedMode: StreamConsumerMode | undefined;
  #coordinatorUnsubscribe: (() => void) | undefined;
  #leadershipTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(options: CoordinatedConsumerRuntimeOptions) {
    this.#options = options;
    this.#ownerId = options.coordinator?.getNodeId() ?? "single-process";
  }

  get ownerId(): string {
    return this.#ownerId;
  }

  get hasRequestedConsumer(): boolean {
    return this.#requestedMode !== undefined;
  }

  isCurrentLeader(): boolean {
    return (
      !this.#options.coordinator || this.#options.coordinator.isLeader(this.#options.collectionId)
    );
  }

  request(mode: StreamConsumerMode): void {
    if (this.#closed) {
      return;
    }

    this.#requestedMode = this.#requestedMode === "long-poll" ? "long-poll" : mode;
    this.#ensureCoordinatorSubscription();
    this.reevaluateLeadership();
    this.#ensureLeadershipPolling();
  }

  /** Retry a request that was blocked by an active finite consumer or a previous follower state. */
  reevaluateLeadership(): void {
    if (this.#closed || this.#requestedMode === undefined || !this.isCurrentLeader()) {
      return;
    }

    const requestedMode = this.#requestedMode;
    if (requestedMode === false) {
      this.#requestedMode = undefined;
    }

    const started = this.#options.startConsumer(requestedMode);
    if (!started && requestedMode === false) {
      this.#requestedMode = false;
    }
  }

  publish(payload: unknown): void {
    this.#options.coordinator?.publish(this.#options.collectionId, {
      v: 1,
      dbName: this.#options.collectionId,
      collectionId: this.#options.collectionId,
      senderId: this.#ownerId,
      ts: Date.now(),
      payload,
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#leadershipTimer) {
      clearInterval(this.#leadershipTimer);
      this.#leadershipTimer = undefined;
    }
    this.#coordinatorUnsubscribe?.();
    this.#coordinatorUnsubscribe = undefined;
  }

  #ensureCoordinatorSubscription(): void {
    if (!this.#options.coordinator || this.#coordinatorUnsubscribe) {
      return;
    }

    this.#coordinatorUnsubscribe = this.#options.coordinator.subscribe(
      this.#options.collectionId,
      (message) => {
        void Promise.resolve()
          .then(() => this.#options.onMessage(message))
          .catch(this.#options.onError);
      },
    );
  }

  #ensureLeadershipPolling(): void {
    if (!this.#options.coordinator || this.#leadershipTimer) {
      return;
    }

    this.#leadershipTimer = setInterval(
      () => this.reevaluateLeadership(),
      this.#options.leadershipPollIntervalMs ?? 25,
    );
  }
}
