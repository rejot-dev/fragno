import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { BackofficeObjectAlarm } from "../local-durable-objects";
import { SqliteBackofficeObjectStorage, type SqliteObjectClaim } from "./sqlite-object-storage";

const OBJECT_CLAIM_DURATION_MS = 30_000;
const OBJECT_CLAIM_RENEWAL_MS = 10_000;
const OBJECT_INITIALIZATION_WAIT_MS = 30_000;
const OBJECT_CLAIM_RETRY_MS = 20;

type ActiveObjectClaim = {
  objectId: string;
  claim: SqliteObjectClaim;
  status: "held" | "lost" | "released";
  operations: number;
  renewal: ReturnType<typeof setInterval>;
};

async function waitForObjectInitializationRetry(objectId: string, deadline: number): Promise<void> {
  if (performance.now() >= deadline) {
    throw new Error(`BACKOFFICE_OBJECT_INITIALIZATION_TIMEOUT:${objectId}`);
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, OBJECT_CLAIM_RETRY_MS);
  });
}

/** Coordinates only initialization and alarm delivery; ordinary events never acquire a claim. */
export class SqliteObjectCoordination {
  readonly #ownerId = `${process.pid}:${randomUUID()}`;
  readonly #context = new AsyncLocalStorage<readonly ActiveObjectClaim[]>();
  readonly #storage: SqliteBackofficeObjectStorage;
  readonly #initializations = new Set<Promise<unknown>>();
  readonly #initializationWaiters = new Map<string, Promise<void>>();

  constructor(storage: SqliteBackofficeObjectStorage) {
    this.#storage = storage;
  }

  claimsForMutation(objectId: string): SqliteObjectClaim[] {
    return (this.#context.getStore() ?? [])
      .filter((active) => active.objectId === objectId && active.status !== "released")
      .map((active) => {
        this.#assertHeld(active);
        return active.claim;
      });
  }

  async waitForInitialization(objectId: string): Promise<void> {
    if (this.#initializationContext(objectId)) {
      return;
    }
    let waiter = this.#initializationWaiters.get(objectId);
    if (!waiter) {
      // A traffic burst shares one SQLite polling loop and the first waiter's deadline.
      waiter = this.#waitForInitialization(objectId).finally(() => {
        this.#initializationWaiters.delete(objectId);
      });
      this.#initializationWaiters.set(objectId, waiter);
    }
    await waiter;
  }

  async #waitForInitialization(objectId: string): Promise<void> {
    const deadline = performance.now() + OBJECT_INITIALIZATION_WAIT_MS;
    while (this.#storage.hasInitializationClaim(objectId)) {
      await waitForObjectInitializationRetry(objectId, deadline);
    }
  }

  initialize<T>(objectId: string, callback: () => Promise<T>): Promise<T> {
    const initialization = this.#initialize(objectId, callback).finally(() => {
      this.#initializations.delete(initialization);
    });
    this.#initializations.add(initialization);
    return initialization;
  }

  async waitForIdle(): Promise<void> {
    while (this.#initializations.size > 0 || this.#initializationWaiters.size > 0) {
      await Promise.allSettled([...this.#initializations, ...this.#initializationWaiters.values()]);
    }
  }

  async #initialize<T>(objectId: string, callback: () => Promise<T>): Promise<T> {
    const nested = this.#initializationContext(objectId);
    if (nested) {
      nested.operations += 1;
      try {
        return await callback();
      } finally {
        this.#endOperation(nested);
      }
    }
    const deadline = performance.now() + OBJECT_INITIALIZATION_WAIT_MS;
    while (true) {
      const claim = this.#storage.acquireClaim(objectId, this.#ownerId, OBJECT_CLAIM_DURATION_MS, {
        kind: "initialization",
      });
      if (claim) {
        return await this.#runClaim(objectId, claim, callback);
      }
      await waitForObjectInitializationRetry(objectId, deadline);
    }
  }

  async deliverAlarm(
    objectId: string,
    alarm: BackofficeObjectAlarm,
    callback: () => Promise<void>,
  ): Promise<boolean> {
    const claim = this.#storage.acquireClaim(objectId, this.#ownerId, OBJECT_CLAIM_DURATION_MS, {
      kind: "alarm",
      alarm,
    });
    // A competing processor skips this delivery rather than holding up its other objects.
    if (!claim) {
      return false;
    }
    return await this.#runClaim(objectId, claim, async () => {
      await callback();
      this.#storage.acknowledgeAlarm(objectId, claim, alarm.generation);
      return true;
    });
  }

  #initializationContext(objectId: string): ActiveObjectClaim | undefined {
    const active = this.#context
      .getStore()
      ?.find(
        (entry) =>
          entry.objectId === objectId &&
          entry.claim.kind === "initialization" &&
          entry.status !== "released",
      );
    if (active) {
      this.#assertHeld(active);
    }
    return active;
  }

  async #runClaim<T>(
    objectId: string,
    claim: SqliteObjectClaim,
    callback: () => Promise<T>,
  ): Promise<T> {
    const active: ActiveObjectClaim = {
      objectId,
      claim,
      status: "held",
      operations: 1,
      renewal: setInterval(() => {
        try {
          if (!this.#storage.renewClaim(objectId, this.#ownerId, claim, OBJECT_CLAIM_DURATION_MS)) {
            active.status = "lost";
          }
        } catch {
          active.status = "lost";
        }
        if (active.status === "lost") {
          clearInterval(active.renewal);
        }
      }, OBJECT_CLAIM_RENEWAL_MS),
    };
    active.renewal.unref();
    try {
      return await this.#context.run([...(this.#context.getStore() ?? []), active], callback);
    } finally {
      this.#endOperation(active);
    }
  }

  #endOperation(active: ActiveObjectClaim): void {
    active.operations -= 1;
    if (active.operations > 0) {
      return;
    }
    // Timers created during initialization (including Fragno polling) must not inherit its claim.
    active.status = "released";
    clearInterval(active.renewal);
    this.#storage.releaseClaim(active.objectId, this.#ownerId, active.claim);
  }

  #assertHeld(active: ActiveObjectClaim): void {
    if (active.status !== "held") {
      throw new Error(`BACKOFFICE_OBJECT_CLAIM_LOST:${active.objectId}:${active.claim.kind}`);
    }
  }
}
