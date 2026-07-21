type TransactionIdWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/** Resolves callers when a committed State Protocol transaction ID is observed. */
export class TransactionIdTracker {
  readonly #observed = new Set<string>();
  readonly #waiters = new Map<string, Set<TransactionIdWaiter>>();

  waitFor(txid: string, timeout = 5_000): Promise<void> {
    if (!txid) {
      return Promise.reject(new Error("awaitTxId requires a non-empty transaction ID."));
    }
    if (!Number.isFinite(timeout) || timeout < 0) {
      return Promise.reject(new Error("awaitTxId timeout must be a non-negative number."));
    }
    if (this.#observed.has(txid)) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiters = this.#waiters.get(txid) ?? new Set<TransactionIdWaiter>();
      const waiter: TransactionIdWaiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            this.#waiters.delete(txid);
          }
          reject(new Error(`Timed out waiting for transaction ${txid}.`));
        }, timeout),
      };
      waiters.add(waiter);
      this.#waiters.set(txid, waiters);
    });
  }

  observe(txids: readonly string[]): void {
    for (const txid of txids) {
      this.#observed.add(txid);
      for (const waiter of this.#waiters.get(txid) ?? []) {
        clearTimeout(waiter.timeout);
        waiter.resolve();
      }
      this.#waiters.delete(txid);
    }
  }

  rejectAll(error: Error): void {
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }
    this.#waiters.clear();
  }
}
