import { compareStreamOffsets, INITIAL_STREAM_OFFSET, parseStreamOffset } from "./stream-offset";

type NonErrorStatus = "idle" | "loading" | "ready" | "closed";

export type FragnoStreamDBStatus =
  | {
      readonly status: NonErrorStatus;
      readonly offset: string;
      readonly error: null;
    }
  | {
      readonly status: "error";
      readonly offset: string;
      readonly error: Error;
    };

type StreamReadyWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export type StreamErrorTransition = {
  error: Error;
  enteredError: boolean;
};

export class StreamStatusController {
  #current: FragnoStreamDBStatus = {
    status: "idle",
    offset: INITIAL_STREAM_OFFSET,
    error: null,
  };
  #hasReachedReady = false;
  readonly #listeners = new Set<(status: FragnoStreamDBStatus) => void>();
  readonly #readyWaiters = new Set<StreamReadyWaiter>();

  get current(): FragnoStreamDBStatus {
    return this.#current;
  }

  get offset(): string {
    return this.#current.offset;
  }

  observeOffset(offset: string): void {
    this.#current = { ...this.#current, offset };
  }

  beginSynchronization(): void {
    if (this.#current.status !== "closed") {
      this.#set({ status: "loading", offset: this.offset, error: null });
    }
  }

  markLoading(offset: string): void {
    if (this.#current.status !== "error" && this.#current.status !== "closed") {
      this.#set({ status: "loading", offset, error: null });
    }
  }

  markReady(offset: string = this.offset): void {
    if (this.#current.status === "error" || this.#current.status === "closed") {
      return;
    }

    if (!this.#hasReachedReady) {
      this.#hasReachedReady = true;
      for (const waiter of this.#readyWaiters) {
        waiter.resolve();
      }
      this.#readyWaiters.clear();
    }
    this.#set({ status: "ready", offset, error: null });
  }

  markError(error: Error): StreamErrorTransition {
    if (this.#current.status === "error") {
      return { error: this.#current.error, enteredError: false };
    }
    if (this.#current.status === "closed") {
      return { error: new Error("Fragno stream database is closed."), enteredError: false };
    }

    this.#set({ status: "error", offset: this.offset, error });
    this.#rejectReadyWaiters(error);
    return { error, enteredError: true };
  }

  markClosed(): void {
    const error = new Error("Fragno stream database closed.");
    this.#rejectReadyWaiters(error);
    this.#set({ status: "closed", offset: this.offset, error: null });
  }

  waitUntilReady(): Promise<void> {
    if (this.#current.status === "error") {
      return Promise.reject(this.#current.error);
    }
    if (this.#current.status === "closed") {
      return Promise.reject(new Error("Fragno stream database is closed."));
    }
    if (this.#hasReachedReady) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.#readyWaiters.add({ resolve, reject });
    });
  }

  waitUntilReadyAfterOffset(afterOffset: string): Promise<void> {
    const parsedOffset = parseStreamOffset(afterOffset, "drain afterOffset");
    const hasAdvanced = (status: FragnoStreamDBStatus) =>
      status.status === "ready" && compareStreamOffsets(status.offset, parsedOffset) > 0;

    if (hasAdvanced(this.#current)) {
      return Promise.resolve();
    }
    if (this.#current.status === "error") {
      return Promise.reject(this.#current.error);
    }
    if (this.#current.status === "closed") {
      return Promise.reject(new Error("Fragno stream database is closed."));
    }

    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const listener = (status: FragnoStreamDBStatus) => {
        if (hasAdvanced(status)) {
          unsubscribe();
          resolve();
        } else if (status.status === "error") {
          unsubscribe();
          reject(status.error);
        } else if (status.status === "closed") {
          unsubscribe();
          reject(new Error("Fragno stream database closed before its offset advanced."));
        }
      };
      unsubscribe = this.subscribe(listener);
      listener(this.#current);
    });
  }

  subscribe(listener: (status: FragnoStreamDBStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(next: FragnoStreamDBStatus): void {
    this.#current = next;
    for (const listener of this.#listeners) {
      listener(next);
    }
  }

  #rejectReadyWaiters(error: Error): void {
    for (const waiter of this.#readyWaiters) {
      waiter.reject(error);
    }
    this.#readyWaiters.clear();
  }
}
