import { assert, describe, expect, test, vi } from "vitest";

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import { createInMemoryBackofficeRuntime } from "../in-memory-runtime";
import { startNodeBackofficeAlarmScheduler } from "./node-alarm-scheduler";

function createVoidDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("file-backed SQLite Backoffice scenario", () => {
  test("password sign-up and Fragment state survive runtime restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-sqlite-scenario-"));
    try {
      const options = { sqliteDataDirectory: directory };
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "register account on SQLite",
          options,
          steps: ({ when, then }) => [
            when.auth.signUp({ email: "persisted@example.com" }),
            then.assert("auth and Fragment databases exist on disk", async () => {
              const files = await readdir(directory);
              assert(files.includes("auth.sqlite"));
              assert(files.includes("objects.sqlite"));
              assert(
                files.some((name) => name.startsWith("automations-") && name.endsWith(".sqlite")),
              );
            }),
          ],
        }),
      );

      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "sign in to account after process restart",
          options,
          steps: ({ then }) => [
            then.assert("persisted credentials authenticate", async ({ runtime }) => {
              const response = await runtime.objects.auth.singleton().http.fetch(
                new Request("https://backoffice.example/api/auth/sign-in/email", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    origin: "https://backoffice.example",
                  },
                  body: JSON.stringify({ email: "persisted@example.com", password: "password123" }),
                }),
              );
              assert.equal(response.status, 200);
            }),
          ],
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("foreground and background runtimes discover shared object state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-sqlite-processes-"));
    const objectFactories = {
      UPLOAD: ({ state }: { state: { storage: DurableObjectStorage } }) => ({
        async fetch(request: Request) {
          if (new URL(request.url).pathname === "/schedule") {
            await state.storage.put("config", { value: "shared" });
            await state.storage.setAlarm(Date.now() - 1);
            return new Response(null, { status: 204 });
          }
          return Response.json({
            config: await state.storage.get("config"),
            fired: await state.storage.get("fired"),
          });
        },
        async alarm() {
          await state.storage.put("fired", true);
        },
      }),
    };
    const background = await createInMemoryBackofficeRuntime({
      sqliteDataDirectory: directory,
      objectFactories,
    });
    const foreground = await createInMemoryBackofficeRuntime({
      sqliteDataDirectory: directory,
      objectFactories,
    });
    const objectUrl = "https://backoffice.example";

    try {
      const scheduled = await foreground.objects.upload
        .forOrg("org-1")
        .http.fetch(new Request(`${objectUrl}/schedule`));
      assert.equal(scheduled.status, 204);

      await background.discoverPersistedObjects();
      await background.drainWaitUntil();
      await background.drainAlarms();

      const response = await foreground.objects.upload
        .forOrg("org-1")
        .http.fetch(new Request(`${objectUrl}/state`));
      assert.deepEqual(await response.json(), {
        config: { value: "shared" },
        fired: true,
      });
    } finally {
      await foreground.cleanup();
      await background.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("two background runtimes deliver one persisted alarm generation once", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-sqlite-alarm-claim-"));
    let alarmCalls = 0;
    const objectFactories = {
      UPLOAD: ({ state }: { state: { storage: DurableObjectStorage } }) => ({
        async fetch() {
          await state.storage.setAlarm(Date.now() - 1);
          return new Response(null, { status: 204 });
        },
        async alarm() {
          alarmCalls += 1;
        },
      }),
    };
    const firstRuntime = await createInMemoryBackofficeRuntime({
      sqliteDataDirectory: directory,
      objectFactories,
    });
    const secondRuntime = await createInMemoryBackofficeRuntime({
      sqliteDataDirectory: directory,
      objectFactories,
    });

    try {
      await firstRuntime.objects.upload
        .forOrg("org-1")
        .http.fetch(new Request("https://backoffice.example/schedule"));
      await secondRuntime.discoverPersistedObjects();

      await Promise.all([firstRuntime.drainAlarms(), secondRuntime.drainAlarms()]);
      assert.equal(alarmCalls, 1);
    } finally {
      await firstRuntime.cleanup();
      await secondRuntime.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["success", "failure", "reschedule"] as const)(
    "overlapping local alarm drains allow only one handler at a time: %s",
    async (outcome) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-sqlite-alarm-overlap-"));
      const alarmStarted = createVoidDeferred();
      const releaseAlarm = createVoidDeferred();
      const scheduledAt = Date.now() - 1;
      let alarmCalls = 0;
      const runtime = await createInMemoryBackofficeRuntime({
        sqliteDataDirectory: directory,
        objectFactories: {
          UPLOAD: ({ state }: { state: { storage: DurableObjectStorage } }) => ({
            async fetch(request: Request) {
              if (new URL(request.url).pathname === "/schedule") {
                await state.storage.setAlarm(scheduledAt);
                return new Response(null, { status: 204 });
              }
              return Response.json({
                completed: (await state.storage.get<number>("completed")) ?? 0,
                alarm: await state.storage.getAlarm(),
              });
            },
            async alarm() {
              alarmCalls += 1;
              if (alarmCalls === 1) {
                if (outcome === "reschedule") {
                  await state.storage.setAlarm(scheduledAt);
                }
                alarmStarted.resolve();
                await releaseAlarm.promise;
                if (outcome === "failure") {
                  throw new Error("Expected overlapping alarm failure.");
                }
              }
              const completed = (await state.storage.get<number>("completed")) ?? 0;
              await state.storage.put("completed", completed + 1);
            },
          }),
        },
      });

      try {
        const object = runtime.objects.upload.forOrg("org-1");
        await object.http.fetch(new Request("https://backoffice.example/schedule"));
        const firstDrainOutcome = runtime.drainAlarms().then(
          () => null,
          (error: unknown) => error,
        );
        await alarmStarted.promise;

        await runtime.drainAlarms();
        assert.equal(alarmCalls, 1);

        releaseAlarm.resolve();
        const firstError = await firstDrainOutcome;
        if (outcome === "failure") {
          expect(firstError).toBeInstanceOf(AggregateError);
          expect(firstError).toHaveProperty(
            "message",
            "One or more local Backoffice object alarms failed.",
          );
        } else {
          assert.equal(firstError, null);
        }
        const afterFirst = await object.http.fetch(new Request("https://backoffice.example/state"));
        assert.deepEqual(await afterFirst.json(), {
          completed: outcome === "failure" ? 0 : 1,
          alarm: outcome === "success" ? null : scheduledAt,
        });

        await runtime.drainAlarms();
        await runtime.drainAlarms();
        assert.equal(alarmCalls, outcome === "success" ? 1 : 2);
        const afterRetry = await object.http.fetch(new Request("https://backoffice.example/state"));
        assert.deepEqual(await afterRetry.json(), {
          completed: outcome === "reschedule" ? 2 : 1,
          alarm: null,
        });
      } finally {
        releaseAlarm.resolve();
        await runtime.cleanup();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("a failed alarm remains pending across a runtime restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-sqlite-alarm-retry-"));
    let failAlarm = true;
    const objectFactories = {
      UPLOAD: ({ state }: { state: { storage: DurableObjectStorage } }) => ({
        async fetch(request: Request) {
          if (new URL(request.url).pathname === "/schedule") {
            await state.storage.setAlarm(Date.now() - 1);
            return new Response(null, { status: 204 });
          }
          return Response.json({ fired: await state.storage.get("fired") });
        },
        async alarm() {
          if (failAlarm) {
            throw new Error("Expected persisted alarm failure.");
          }
          await state.storage.put("fired", true);
        },
      }),
    };
    const options = { sqliteDataDirectory: directory, objectFactories };
    const firstRuntime = await createInMemoryBackofficeRuntime(options);

    try {
      const scheduled = await firstRuntime.objects.upload
        .forOrg("org-1")
        .http.fetch(new Request("https://backoffice.example/schedule"));
      assert.equal(scheduled.status, 204);
      await expect(firstRuntime.drainAlarms()).rejects.toThrow(
        "One or more local Backoffice object alarms failed.",
      );
    } finally {
      await firstRuntime.cleanup();
    }

    failAlarm = false;
    const restartedRuntime = await createInMemoryBackofficeRuntime(options);
    try {
      await restartedRuntime.drainAlarms();
      const response = await restartedRuntime.objects.upload
        .forOrg("org-1")
        .http.fetch(new Request("https://backoffice.example/state"));
      assert.deepEqual(await response.json(), { fired: true });
    } finally {
      await restartedRuntime.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("SQLite acknowledgement preserves an alarm rescheduled for the same timestamp", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-sqlite-alarm-generation-"));
    const scheduledAt = Date.now() - 1;
    let alarmCalls = 0;
    const runtime = await createInMemoryBackofficeRuntime({
      sqliteDataDirectory: directory,
      objectFactories: {
        UPLOAD: ({ state }: { state: { storage: DurableObjectStorage } }) => ({
          async fetch() {
            await state.storage.setAlarm(scheduledAt);
            return new Response(null, { status: 204 });
          },
          async alarm() {
            alarmCalls += 1;
            assert.equal(await state.storage.getAlarm(), null);
            if (alarmCalls === 1) {
              await state.storage.setAlarm(scheduledAt);
            }
          },
        }),
      },
    });

    try {
      await runtime.objects.upload
        .forOrg("org-1")
        .http.fetch(new Request("https://backoffice.example/schedule"));
      await runtime.drainAlarms();
      await runtime.drainAlarms();
      await runtime.drainAlarms();
      assert.equal(alarmCalls, 2);
    } finally {
      await runtime.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("alarm scheduler shutdown waits for the active alarm delivery", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-sqlite-alarm-shutdown-"));
    const alarmStarted = createVoidDeferred();
    const releaseAlarm = createVoidDeferred();
    const runtime = await createInMemoryBackofficeRuntime({
      sqliteDataDirectory: directory,
      objectFactories: {
        UPLOAD: ({ state }: { state: { storage: DurableObjectStorage } }) => ({
          async fetch(request: Request) {
            if (new URL(request.url).pathname === "/schedule") {
              await state.storage.setAlarm(Date.now() - 1);
              return new Response(null, { status: 204 });
            }
            return Response.json({ alarmFinished: await state.storage.get("alarmFinished") });
          },
          async alarm() {
            alarmStarted.resolve();
            await releaseAlarm.promise;
            await state.storage.put("alarmFinished", true);
          },
        }),
      },
    });
    const scheduler = startNodeBackofficeAlarmScheduler(runtime, { intervalMs: 1 });

    try {
      await runtime.objects.upload
        .forOrg("org-1")
        .http.fetch(new Request("https://backoffice.example/schedule"));
      await alarmStarted.promise;

      let schedulerStopped = false;
      const stopping = scheduler.stop().then(() => {
        schedulerStopped = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(schedulerStopped, false);

      releaseAlarm.resolve();
      await stopping;
      assert.equal(schedulerStopped, true);

      const response = await runtime.objects.upload
        .forOrg("org-1")
        .http.fetch(new Request("https://backoffice.example/state"));
      assert.deepEqual(await response.json(), { alarmFinished: true });
    } finally {
      releaseAlarm.resolve();
      await scheduler.stop();
      await runtime.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("object storage and a pending alarm survive runtime restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-sqlite-alarm-"));
    const objectFactories = {
      UPLOAD: ({ state }: { state: { storage: DurableObjectStorage } }) => ({
        async fetch(request: Request) {
          if (new URL(request.url).pathname === "/schedule") {
            await state.storage.put("config", { value: "persisted" });
            await state.storage.setAlarm(Date.now() + 60_000);
            return new Response(null, { status: 204 });
          }
          return Response.json({
            config: await state.storage.get("config"),
            fired: await state.storage.get("fired"),
          });
        },
        async alarm() {
          await state.storage.put("fired", true);
        },
      }),
    };
    const options = { sqliteDataDirectory: directory };
    const url = "https://backoffice.example/schedule";
    try {
      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "schedule a persisted upload object alarm",
          options,
          objectFactories,
          steps: () => [
            {
              kind: "when",
              type: "upload.schedulePersistedAlarm",
              label: "persist an object configuration and future alarm",
              async run({ runtime }) {
                const response = await runtime.objects.upload
                  .forOrg("org-1")
                  .http.fetch(new Request(url));
                assert.equal(response.status, 204);
              },
            },
          ],
        }),
      );

      await runBackofficeScenario(
        defineBackofficeScenario({
          name: "deliver persisted upload object alarm after restart",
          options,
          objectFactories,
          steps: ({ then }) => [
            then.assert(
              "restored object runs its alarm and retains its configuration",
              async ({ runtime }) => {
                runtime.advanceTime(61_000);
                await runtime.drainAlarms();
                const response = await runtime.objects.upload
                  .forOrg("org-1")
                  .http.fetch(new Request(url.replace("/schedule", "/state")));
                assert.deepEqual(await response.json(), {
                  config: { value: "persisted" },
                  fired: true,
                });
              },
            ),
          ],
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
