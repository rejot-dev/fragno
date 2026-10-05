import { randomUUID } from "node:crypto";

import {
  readNodeRuntimeEpochMilliseconds,
  type NodeRuntimeClock,
} from "../runtime/node-runtime-clock";
import type { ManagedNodeRuntimeObjectDatabase } from "../sqlite/managed-node-runtime-object-database";
import { GraftControlStore, type GraftObjectAlarmPublication } from "./graft-control-store";
import type { GraftObjectAuthority } from "./graft-object-authority";

/** One authoritative alarm installation in an object's Graft database, with its generation. */
export type GraftObjectAlarm = {
  timestamp: number;
  generation: number;
  installationId: string;
};

/** Coordinates object alarm mutations across the authoritative object log and discovery index. */
export class GraftObjectAlarmCoordinator {
  readonly #database: ManagedNodeRuntimeObjectDatabase;
  readonly #controlStore: GraftControlStore;
  readonly #authority: GraftObjectAuthority;
  readonly #clock: NodeRuntimeClock;
  #alarmMutationTail = Promise.resolve();

  constructor(options: {
    database: ManagedNodeRuntimeObjectDatabase;
    controlStore: GraftControlStore;
    authority: GraftObjectAuthority;
    clock: NodeRuntimeClock;
  }) {
    this.#database = options.database;
    this.#controlStore = options.controlStore;
    this.#authority = options.authority;
    this.#clock = options.clock;
  }

  setAlarm(timestamp: number): Promise<void> {
    return this.#serializeAlarmMutation(async () => {
      const reconciliationId = this.#beginAlarmChange();
      const installationId = randomUUID();
      this.#database.write((database) => {
        database.run(
          `INSERT INTO node_runtime_alarm
            (singleton, timestamp, generation, installation_id)
           VALUES (1, ?, 1, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             timestamp = excluded.timestamp,
             generation = node_runtime_alarm.generation + 1,
             installation_id = excluded.installation_id`,
          [timestamp, installationId],
        );
      });
      this.#pushObjectAlarmChange();
      this.#completeAlarmChange(reconciliationId, {
        kind: "scheduled",
        installationId,
        dueAtMs: timestamp,
      });
    });
  }

  deleteAlarm(): Promise<void> {
    return this.#serializeAlarmMutation(async () => {
      const reconciliationId = this.#beginAlarmChange();
      this.#database.write((database) => {
        database.run("DELETE FROM node_runtime_alarm WHERE singleton = 1", []);
      });
      this.#pushObjectAlarmChange();
      this.#completeAlarmChange(reconciliationId, { kind: "none" });
    });
  }

  consumeAlarm(expectedInstallationId: string): Promise<boolean> {
    return this.#serializeAlarmMutation(async () => {
      const alarm = readGraftObjectAlarm(this.#database);
      if (alarm?.installationId !== expectedInstallationId) {
        return false;
      }
      const reconciliationId = this.#beginAlarmChange();
      const consumed = this.#database.write((database) => {
        return (
          database.run("DELETE FROM node_runtime_alarm WHERE installation_id = ?", [
            expectedInstallationId,
          ]).changes === 1
        );
      });
      this.#pushObjectAlarmChange();
      this.#completeAlarmChange(
        reconciliationId,
        consumed ? { kind: "none" } : alarmPublication(readGraftObjectAlarm(this.#database)),
      );
      return consumed;
    });
  }

  reconcileAlarmWork(reconciliationId: string): Promise<void> {
    return this.#serializeAlarmMutation(async () => {
      this.#completeAlarmChange(
        reconciliationId,
        alarmPublication(readGraftObjectAlarm(this.#database)),
        false,
      );
    });
  }

  synchronizeAlarmWork(): Promise<void> {
    return this.#serializeAlarmMutation(async () => {
      const reconciliationId = this.#beginAlarmChange();
      this.#completeAlarmChange(
        reconciliationId,
        alarmPublication(readGraftObjectAlarm(this.#database)),
      );
    });
  }

  close(): void {
    this.#controlStore.close();
  }

  #beginAlarmChange(): string {
    const reconciliationId = randomUUID();
    const attemptedAtMs = readNodeRuntimeEpochMilliseconds(this.#clock);
    const result = this.#controlStore.beginObjectAlarmChange({
      commandId: randomUUID(),
      commandCreatedAtMs: attemptedAtMs,
      input: {
        ...this.#alarmAuthorityInput(attemptedAtMs),
        reconciliationId,
      },
    });
    if (result.outcome !== "begun") {
      throw new Error(`GRAFT_OBJECT_ALARM_CHANGE_REJECTED:${result.outcome}`);
    }
    return reconciliationId;
  }

  #completeAlarmChange(
    reconciliationId: string,
    alarm: GraftObjectAlarmPublication,
    requireCompletion = true,
  ): void {
    const attemptedAtMs = readNodeRuntimeEpochMilliseconds(this.#clock);
    const result = this.#controlStore.completeObjectAlarmChange({
      commandId: randomUUID(),
      commandCreatedAtMs: attemptedAtMs,
      input: {
        ...this.#alarmAuthorityInput(attemptedAtMs),
        reconciliationId,
        alarm,
      },
    });
    if (
      result.outcome === "completed" ||
      (!requireCompletion && result.outcome === "work-changed")
    ) {
      return;
    }
    throw new Error(`GRAFT_OBJECT_ALARM_COMPLETION_REJECTED:${result.outcome}`);
  }

  #pushObjectAlarmChange(): void {
    this.#database.ensureDurableStoragePosition(this.#database.committedStoragePosition);
  }

  #alarmAuthorityInput(attemptedAtMs: number) {
    return {
      objectId: this.#authority.objectId,
      epoch: this.#authority.epoch,
      nodeId: this.#authority.ownerNodeId,
      processGeneration: this.#authority.processGeneration,
      claimId: this.#authority.claimId,
      attemptedAtMs,
    };
  }

  #serializeAlarmMutation<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.#alarmMutationTail.then(operation, operation);
    this.#alarmMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Reads the exact alarm installation currently stored in one Graft object database. */
export function readGraftObjectAlarm(
  database: ManagedNodeRuntimeObjectDatabase,
): GraftObjectAlarm | null {
  return database.read(
    (connection) =>
      connection.get(
        `SELECT timestamp, generation, installation_id AS installationId
         FROM node_runtime_alarm
         WHERE singleton = 1`,
        [],
      ) as GraftObjectAlarm | null,
  );
}

function alarmPublication(alarm: GraftObjectAlarm | null): GraftObjectAlarmPublication {
  return alarm
    ? {
        kind: "scheduled",
        installationId: alarm.installationId,
        dueAtMs: alarm.timestamp,
      }
    : { kind: "none" };
}
