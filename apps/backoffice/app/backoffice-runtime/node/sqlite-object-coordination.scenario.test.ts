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

import { createInMemoryBackofficeRuntime } from "../in-memory-runtime";
import type { LocalObjectFactoryOverrides } from "../local-object-factory";

function createCoordinationGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function objectRequest(pathname: string) {
  return new Request(`https://backoffice.example/${pathname}`);
}

test("ordinary SQL requests and alarm delivery do not acquire object-wide ownership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-narrow-claims-"));
  const requestStarted = createCoordinationGate();
  const releaseRequest = createCoordinationGate();
  const alarmStarted = createCoordinationGate();
  const releaseAlarm = createCoordinationGate();
  let alarmCalls = 0;
  const objectFactories: LocalObjectFactoryOverrides = {
    UPLOAD: ({ state }) => ({
      async fetch(request: Request) {
        switch (new URL(request.url).pathname) {
          case "/schedule":
            await state.storage.setAlarm(0);
            break;
          case "/wait":
            requestStarted.resolve();
            await releaseRequest.promise;
            await state.storage.put("requestFinished", true);
            break;
          case "/write":
            await state.storage.put("concurrentWrite", true);
            break;
          default:
            return Response.json(Object.fromEntries(await state.storage.list()));
        }
        return new Response(null, { status: 204 });
      },
      async alarm() {
        alarmCalls += 1;
        alarmStarted.resolve();
        await releaseAlarm.promise;
        await state.storage.put("alarmFinished", true);
      },
    }),
  };
  const processor = await createInMemoryBackofficeRuntime({
    sqliteDataDirectory: directory,
    objectFactories,
  });
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "ordinary operations remain independent of async work",
        options: { drain: false, sqliteDataDirectory: directory },
        objectFactories,
        steps: ({ then }) => [
          then.assert(
            "writes and alarms progress while another request is suspended",
            async ({ runtime }) => {
              const object = runtime.objects.upload.forOrg("org-1");
              await object.http.fetch(objectRequest("schedule"));
              await processor.discoverPersistedObjects();
              const request = object.http.fetch(objectRequest("wait"));
              await requestStarted.promise;
              const alarm = processor.drainAlarms();
              await alarmStarted.promise;
              try {
                await object.http.fetch(objectRequest("write"));
                await runtime.drainAlarms();
                expect(alarmCalls).toBe(1);
                expect(await (await object.http.fetch(objectRequest("state"))).json()).toEqual({
                  concurrentWrite: true,
                });
              } finally {
                releaseRequest.resolve();
                releaseAlarm.resolve();
                await Promise.all([request, alarm]);
              }
              expect(await (await object.http.fetch(objectRequest("state"))).json()).toEqual({
                concurrentWrite: true,
                requestFinished: true,
                alarmFinished: true,
              });
            },
          ),
        ],
      }),
    );
  } finally {
    releaseRequest.resolve();
    releaseAlarm.resolve();
    await processor.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test("blockConcurrencyWhile serializes initialization but releases before the request finishes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-initialization-"));
  const initializationStarted = createCoordinationGate();
  const releaseInitialization = createCoordinationGate();
  const initializationFinished = createCoordinationGate();
  const releaseRequest = createCoordinationGate();
  const objectFactories: LocalObjectFactoryOverrides = {
    UPLOAD: ({ state }) => ({
      async fetch(request: Request) {
        if (new URL(request.url).pathname === "/initialize") {
          await state.blockConcurrencyWhile(async () => {
            initializationStarted.resolve();
            await releaseInitialization.promise;
            await state.blockConcurrencyWhile(async () => {
              await state.storage.put("initialized", true);
            });
          });
          initializationFinished.resolve();
          await releaseRequest.promise;
          return new Response(null, { status: 204 });
        }
        return Response.json({ initialized: (await state.storage.get("initialized")) ?? false });
      },
    }),
  };
  const other = await createInMemoryBackofficeRuntime({
    sqliteDataDirectory: directory,
    objectFactories,
  });
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "initialization has its own bounded claim",
        options: { drain: false, sqliteDataDirectory: directory },
        objectFactories,
        steps: ({ then }) => [
          then.assert(
            "new events wait for initialization, not the whole request",
            async ({ runtime }) => {
              const initializing = runtime.objects.upload
                .forOrg("org-1")
                .http.fetch(objectRequest("initialize"));
              await initializationStarted.promise;
              let readFinished = false;
              const reading = other.objects.upload
                .forOrg("org-1")
                .http.fetch(objectRequest("state"))
                .then(async (response) => {
                  readFinished = true;
                  return await response.json();
                });
              try {
                await new Promise<void>((resolve) => setImmediate(resolve));
                assert.equal(readFinished, false);
                releaseInitialization.resolve();
                await initializationFinished.promise;
                expect(await reading).toEqual({ initialized: true });
              } finally {
                releaseInitialization.resolve();
                releaseRequest.resolve();
                await Promise.all([initializing, reading]);
              }
            },
          ),
        ],
      }),
    );
  } finally {
    releaseInitialization.resolve();
    releaseRequest.resolve();
    await other.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test("callbacks scheduled during initialization do not retain its released claim", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-released-claim-"));
  const releaseWork = createCoordinationGate();
  let detached: Promise<void> | null = null;
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "released initialization claims do not leak into detached work",
        options: { drain: false, sqliteDataDirectory: directory },
        objectFactories: {
          UPLOAD: ({ state }) => ({
            async fetch(request: Request) {
              if (new URL(request.url).pathname === "/initialize") {
                await state.blockConcurrencyWhile(async () => {
                  detached = releaseWork.promise.then(async () => {
                    await state.storage.put("detached", true);
                    await state.blockConcurrencyWhile(async () => {
                      await state.storage.put("reinitialized", true);
                    });
                  });
                  state.waitUntil(detached);
                });
              }
              return Response.json(Object.fromEntries(await state.storage.list()));
            },
          }),
        },
        steps: ({ then }) => [
          then.assert(
            "later work uses ordinary SQL and a fresh initialization claim",
            async ({ runtime }) => {
              const object = runtime.objects.upload.forOrg("org-1");
              await object.http.fetch(objectRequest("initialize"));
              assert(detached);
              releaseWork.resolve();
              await detached;
              expect(await (await object.http.fetch(objectRequest("state"))).json()).toEqual({
                detached: true,
                reinitialized: true,
              });
            },
          ),
        ],
      }),
    );
  } finally {
    releaseWork.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["initialization", "alarm"] as const)(
  "expired %s work cannot mutate storage or acknowledge a replacement claim",
  async (kind) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-claim-fencing-"));
    const staleStarted = createCoordinationGate();
    const resumeStale = createCoordinationGate();
    const replacementStarted = createCoordinationGate();
    const releaseReplacement = createCoordinationGate();
    let calls = 0;
    let mutationErrors: string[] = [];
    const objectFactories: LocalObjectFactoryOverrides = {
      UPLOAD: ({ state }) => {
        async function claimedWork() {
          calls += 1;
          if (calls === 1) {
            staleStarted.resolve();
            await resumeStale.promise;
            const results = await Promise.allSettled([
              state.storage.put("value", "stale"),
              state.storage.delete("keep"),
              state.storage.setAlarm(999),
              state.storage.deleteAlarm(),
            ]);
            mutationErrors = results.map((result) =>
              result.status === "rejected" ? (result.reason as Error).message : "fulfilled",
            );
          } else {
            await state.storage.put("value", "replacement");
            replacementStarted.resolve();
            await releaseReplacement.promise;
          }
        }
        return {
          async fetch(request: Request) {
            switch (new URL(request.url).pathname) {
              case "/seed":
                await state.storage.put({ value: "original", keep: true });
                await state.storage.setAlarm(0);
                break;
              case "/initialize":
                await state.blockConcurrencyWhile(claimedWork);
                break;
              default:
                return Response.json({
                  ...Object.fromEntries(await state.storage.list()),
                  alarm: await state.storage.getAlarm(),
                });
            }
            return new Response(null, { status: 204 });
          },
          alarm: claimedWork,
        };
      },
    };
    const other = await createInMemoryBackofficeRuntime({
      sqliteDataDirectory: directory,
      objectFactories,
    });
    const database = new Database(path.join(directory, "objects.sqlite"));
    try {
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: `fence stale ${kind} work`,
          options: { drain: false, sqliteDataDirectory: directory },
          objectFactories,
          steps: ({ then }) => [
            then.assert(
              "expired claims cannot affect the replacement owner",
              async ({ runtime }) => {
                await runtime.objects.upload.forOrg("org-1").http.fetch(objectRequest("seed"));
                await other.discoverPersistedObjects();
                const stale =
                  kind === "alarm"
                    ? runtime.drainAlarms()
                    : runtime.objects.upload
                        .forOrg("org-1")
                        .http.fetch(objectRequest("initialize"));
                const staleResult = stale.then(
                  () => null,
                  (error: unknown) => error,
                );
                await staleStarted.promise;
                const row = database
                  .prepare(
                    "SELECT object_id FROM object_coordination_claims WHERE kind = ? AND active = 1",
                  )
                  .get(kind) as { object_id: string };
                assert(row);
                database
                  .prepare(
                    "UPDATE object_coordination_claims SET expires_at = 0 WHERE object_id = ? AND kind = ?",
                  )
                  .run(row.object_id, kind);
                const replacement =
                  kind === "alarm"
                    ? other.drainAlarms()
                    : other.objects.upload.forOrg("org-1").http.fetch(objectRequest("initialize"));
                await replacementStarted.promise;
                try {
                  resumeStale.resolve();
                  const result = await staleResult;
                  if (kind === "alarm") {
                    expect(result).toBeInstanceOf(AggregateError);
                  }
                  expect(mutationErrors).toEqual(
                    Array(4).fill(`BACKOFFICE_OBJECT_CLAIM_LOST:${row.object_id}:${kind}`),
                  );
                  expect(
                    database
                      .prepare(
                        "SELECT active FROM object_coordination_claims WHERE object_id = ? AND kind = ?",
                      )
                      .get(row.object_id, kind),
                  ).toEqual({ active: 1 });
                  expect(
                    database
                      .prepare("SELECT generation FROM object_alarms WHERE object_id = ?")
                      .get(row.object_id),
                  ).toBeDefined();
                } finally {
                  resumeStale.resolve();
                  releaseReplacement.resolve();
                  await Promise.all([staleResult, replacement]);
                }
                const response = await other.objects.upload
                  .forOrg("org-1")
                  .http.fetch(objectRequest("state"));
                expect(await response.json()).toEqual({
                  value: "replacement",
                  keep: true,
                  alarm: kind === "alarm" ? null : 0,
                });
              },
            ),
          ],
        }),
      );
    } finally {
      resumeStale.resolve();
      releaseReplacement.resolve();
      await other.cleanup();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each(["acknowledge", "delete", "postpone"] as const)(
  "an older handler cannot %s an alarm scheduled by a concurrent request",
  async (action) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-concurrent-alarm-"));
    const alarmStarted = createCoordinationGate();
    const releaseAlarm = createCoordinationGate();
    let alarmCalls = 0;
    const objectFactories: LocalObjectFactoryOverrides = {
      UPLOAD: ({ state }) => ({
        async fetch(request: Request) {
          if (new URL(request.url).pathname === "/schedule") {
            await state.storage.setAlarm(0);
          }
          return Response.json({ alarm: await state.storage.getAlarm() });
        },
        async alarm() {
          alarmCalls += 1;
          if (alarmCalls === 1) {
            alarmStarted.resolve();
            await releaseAlarm.promise;
            if (action === "delete") {
              await state.storage.deleteAlarm();
            }
            if (action === "postpone") {
              await state.storage.setAlarm(Date.now() + 60_000);
            }
          }
        },
      }),
    };
    const processor = await createInMemoryBackofficeRuntime({
      sqliteDataDirectory: directory,
      objectFactories,
    });
    try {
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: `preserve concurrent scheduling during alarm ${action}`,
          options: { drain: false, sqliteDataDirectory: directory },
          objectFactories,
          steps: ({ then }) => [
            then.assert(
              "the newer generation survives and is delivered separately",
              async ({ runtime }) => {
                const object = runtime.objects.upload.forOrg("org-1");
                await object.http.fetch(objectRequest("schedule"));
                await processor.discoverPersistedObjects();
                const delivering = processor.drainAlarms();
                await alarmStarted.promise;
                try {
                  await object.http.fetch(objectRequest("schedule"));
                  await runtime.drainAlarms();
                  expect(alarmCalls).toBe(1);
                } finally {
                  releaseAlarm.resolve();
                  await delivering;
                }
                expect(await (await object.http.fetch(objectRequest("state"))).json()).toEqual({
                  alarm: 0,
                });
                await runtime.drainAlarms();
                expect(alarmCalls).toBe(2);
                expect(await (await object.http.fetch(objectRequest("state"))).json()).toEqual({
                  alarm: null,
                });
              },
            ),
          ],
        }),
      );
    } finally {
      releaseAlarm.resolve();
      await processor.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a warm Node object reloads configured and cleared Fragment runtimes from shared storage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-config-refresh-"));
  const other = await createInMemoryBackofficeRuntime({ sqliteDataDirectory: directory });
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "derived runtime configuration follows SQLite",
        options: { drain: false, sqliteDataDirectory: directory },
        steps: ({ then }) => [
          then.assert(
            "configuration changes are visible without reconstructing the object",
            async ({ runtime }) => {
              const reader = other.objects.reson8.forOrg("org-1");
              assert.equal((await reader.http.fetch(objectRequest("unknown-route"))).status, 400);
              const writer = runtime.objects.reson8.forOrg("org-1");
              await writer.commands.setAdminConfig({ apiKey: "scenario-reson8-key" }, "org-1");
              await other.discoverPersistedObjects();
              assert.equal((await reader.http.fetch(objectRequest("unknown-route"))).status, 404);
              await writer.commands.resetAdminConfig();
              assert.equal((await reader.http.fetch(objectRequest("unknown-route"))).status, 400);
            },
          ),
        ],
      }),
    );
  } finally {
    await other.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
