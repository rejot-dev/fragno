import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import type { LocalObjectFactoryOverrides } from "../local-object-factory";
import { SqliteObjectCoordination } from "./sqlite-object-coordination";
import { SqliteBackofficeObjectStorage } from "./sqlite-object-storage";

class ObservedInitializationStorage extends SqliteBackofficeObjectStorage {
  readonly checks = new Map<string, number>();
  readonly #observers = new Set<{ objectId: string; count: number; resolve: () => void }>();

  override hasInitializationClaim(objectId: string): boolean {
    const count = (this.checks.get(objectId) ?? 0) + 1;
    this.checks.set(objectId, count);
    for (const observer of this.#observers) {
      if (observer.objectId === objectId && count >= observer.count) {
        this.#observers.delete(observer);
        observer.resolve();
      }
    }
    return super.hasInitializationClaim(objectId);
  }

  async waitForChecks(objectId: string, count: number): Promise<void> {
    if ((this.checks.get(objectId) ?? 0) >= count) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#observers.add({ objectId, count, resolve });
    });
  }
}

async function createInitializationWaitScenario() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-initialization-waiters-"));
  const storage = new ObservedInitializationStorage(directory);
  const ownerStorage = new SqliteBackofficeObjectStorage(directory);
  const coordinator = new SqliteObjectCoordination(storage);
  const database = new Database(path.join(directory, "objects.sqlite"));
  const objectFactories: LocalObjectFactoryOverrides = {
    // Route requests use the real coordinator and SQLite, with query counts observed at storage.
    UPLOAD: ({ name }) => ({
      async fetch() {
        await coordinator.waitForInitialization(name);
        return Response.json({ initialized: storage.get(name, "initialized") ?? false });
      },
    }),
  };
  return {
    storage,
    ownerStorage,
    coordinator,
    database,
    objectFactories,
    async close() {
      await coordinator.waitForIdle();
      database.close();
      ownerStorage.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("request bursts share initialization polling and shutdown waits for the shared waiter", async () => {
  const fixture = await createInitializationWaitScenario();
  const objectId = "UPLOAD:v1:org:org-1";
  const claim = fixture.ownerStorage.acquireClaim(objectId, "other-process", 30_000, {
    kind: "initialization",
  });
  assert(claim);
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "one initialization poller per object under concurrent traffic",
        options: { drain: false },
        objectFactories: fixture.objectFactories,
        steps: ({ then }) => [
          then.assert(
            "a burst shares polling without blocking other objects",
            async ({ runtime }) => {
              const object = runtime.objects.upload.forOrg("org-1");
              const requests = Array.from({ length: 64 }, async () => {
                const response = await object.http.fetch(
                  new Request("https://backoffice.example/state"),
                );
                return await response.json();
              });
              const responses = Promise.all(requests);
              let idle = false;
              await fixture.storage.waitForChecks(objectId, 2);
              const draining = fixture.coordinator.waitForIdle().then(() => {
                idle = true;
              });
              try {
                const unrelated = await runtime.objects.upload
                  .forOrg("org-2")
                  .http.fetch(new Request("https://backoffice.example/state"));
                expect(await unrelated.json()).toEqual({ initialized: false });
                await new Promise<void>((resolve) => setImmediate(resolve));
                // The old per-request loop performs at least 64 reads before its first retry.
                expect(fixture.storage.checks.get(objectId)).toBeLessThan(10);
                assert.equal(idle, false);
                fixture.ownerStorage.put(objectId, [claim], new Map([["initialized", true]]));
              } finally {
                fixture.ownerStorage.releaseClaim(objectId, "other-process", claim);
                await Promise.all([responses, draining]);
              }
              expect(await responses).toEqual(Array(64).fill({ initialized: true }));
              assert.equal(idle, true);

              const secondClaim = fixture.ownerStorage.acquireClaim(
                objectId,
                "other-process",
                30_000,
                { kind: "initialization" },
              );
              assert(secondClaim);
              const checksBefore = fixture.storage.checks.get(objectId)!;
              let completed = false;
              const next = object.http
                .fetch(new Request("https://backoffice.example/state"))
                .then(() => {
                  completed = true;
                });
              try {
                await fixture.storage.waitForChecks(objectId, checksBefore + 1);
                assert.equal(completed, false);
              } finally {
                fixture.ownerStorage.releaseClaim(objectId, "other-process", secondClaim);
                await next;
              }
            },
          ),
        ],
      }),
    );
  } finally {
    fixture.ownerStorage.releaseClaim(objectId, "other-process", claim);
    await fixture.close();
  }
});

test("a failed shared initialization waiter is removed so subsequent requests can retry", async () => {
  const fixture = await createInitializationWaitScenario();
  const objectId = "UPLOAD:v1:org:org-1";
  const claim = fixture.ownerStorage.acquireClaim(objectId, "other-process", 30_000, {
    kind: "initialization",
  });
  assert(claim);
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "SQLite polling failure rejects its cohort but does not poison later requests",
        options: { drain: false },
        objectFactories: fixture.objectFactories,
        steps: ({ then }) => [
          then.assert("requests share the failure and later recover", async ({ runtime }) => {
            const object = runtime.objects.upload.forOrg("org-1");
            const results = Promise.allSettled(
              Array.from({ length: 16 }, () =>
                object.http.fetch(new Request("https://backoffice.example/state")),
              ),
            );
            await fixture.storage.waitForChecks(objectId, 1);
            await new Promise<void>((resolve) => setImmediate(resolve));
            fixture.database.exec(
              "ALTER TABLE object_coordination_claims RENAME TO unavailable_claims",
            );
            try {
              const settled = await results;
              const firstFailure = settled[0];
              assert(firstFailure.status === "rejected");
              for (const result of settled) {
                assert(result.status === "rejected");
                expect(result.reason).toBe(firstFailure.reason);
                expect((result.reason as Error).message).toContain("no such table");
              }
              await fixture.coordinator.waitForIdle();
            } finally {
              fixture.database.exec(
                "ALTER TABLE unavailable_claims RENAME TO object_coordination_claims",
              );
            }
            const checksBefore = fixture.storage.checks.get(objectId)!;
            const retried = object.http.fetch(new Request("https://backoffice.example/state"));
            try {
              await fixture.storage.waitForChecks(objectId, checksBefore + 1);
              fixture.ownerStorage.put(objectId, [claim], new Map([["initialized", true]]));
            } finally {
              fixture.ownerStorage.releaseClaim(objectId, "other-process", claim);
            }
            expect(await (await retried).json()).toEqual({ initialized: true });
          }),
        ],
      }),
    );
  } finally {
    fixture.ownerStorage.releaseClaim(objectId, "other-process", claim);
    await fixture.close();
  }
});

test("an initialization owner bypasses the shared waiter for its own object", async () => {
  const fixture = await createInitializationWaitScenario();
  const objectId = "UPLOAD:v1:org:org-1";
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "initialization does not await events that are waiting for it",
        options: { drain: false },
        objectFactories: fixture.objectFactories,
        steps: ({ then }) => [
          then.assert("the owner finishes while other events are queued", async ({ runtime }) => {
            const initializing = fixture.coordinator.initialize(objectId, async () => {
              await fixture.storage.waitForChecks(objectId, 1);
              await fixture.coordinator.waitForInitialization(objectId);
              fixture.storage.put(
                objectId,
                fixture.coordinator.claimsForMutation(objectId),
                new Map([["initialized", true]]),
              );
            });
            const response = runtime.objects.upload
              .forOrg("org-1")
              .http.fetch(new Request("https://backoffice.example/state"));
            await initializing;
            expect(await (await response).json()).toEqual({ initialized: true });
          }),
        ],
      }),
    );
  } finally {
    await fixture.close();
  }
});
