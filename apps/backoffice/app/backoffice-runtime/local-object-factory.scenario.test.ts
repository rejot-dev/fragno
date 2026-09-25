import { assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

function createVoidDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("failed alarms remain deliverable while later alarms are acknowledged", async () => {
  const alarmCalls: string[] = [];
  let failFirstAlarm = true;

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "failed alarms remain deliverable while later alarms are acknowledged",
      options: { drain: false },
      objectFactories: {
        UPLOAD: ({ name, state, nowEpochMs }) => ({
          async fetch() {
            await state.storage.setAlarm(nowEpochMs());
            return new Response(null, { status: 204 });
          },
          async alarm() {
            alarmCalls.push(name);
            expect(await state.storage.getAlarm()).toBeNull();
            if (name.endsWith("org-1") && failFirstAlarm) {
              throw new Error("Expected alarm failure.");
            }
          },
        }),
      },
      steps: ({ then }) => [
        then.assert("schedule alarms for two objects", async ({ runtime }) => {
          await runtime.objects.upload
            .forOrg("org-1")
            .http.fetch(new Request("https://backoffice.example/schedule"));
          await runtime.objects.upload
            .forOrg("org-2")
            .http.fetch(new Request("https://backoffice.example/schedule"));
        }),
        then.assert(
          "the failed alarm remains while the later alarm is acknowledged",
          async ({ runtime }) => {
            await expect(runtime.drainAlarms()).rejects.toThrow(
              "One or more local Backoffice object alarms failed.",
            );
            expect(alarmCalls).toEqual(["UPLOAD:v1:org:org-1", "UPLOAD:v1:org:org-2"]);

            failFirstAlarm = false;
            await runtime.drainAlarms();
            expect(alarmCalls).toEqual([
              "UPLOAD:v1:org:org-1",
              "UPLOAD:v1:org:org-2",
              "UPLOAD:v1:org:org-1",
            ]);
          },
        ),
      ],
    }),
  );
});

test("an alarm rescheduled by its handler remains deliverable", async () => {
  let alarmCalls = 0;

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "an alarm rescheduled by its handler remains deliverable",
      options: { drain: false },
      objectFactories: {
        UPLOAD: ({ state, nowEpochMs }) => ({
          async fetch() {
            await state.storage.setAlarm(nowEpochMs());
            return new Response(null, { status: 204 });
          },
          async alarm() {
            alarmCalls += 1;
            expect(await state.storage.getAlarm()).toBeNull();
            if (alarmCalls === 1) {
              await state.storage.setAlarm(nowEpochMs());
            }
          },
        }),
      },
      steps: ({ then }) => [
        then.assert("schedule the first alarm", async ({ runtime }) => {
          await runtime.objects.upload
            .forOrg("org-1")
            .http.fetch(new Request("https://backoffice.example/schedule"));
        }),
        then.assert("deliver the original and rescheduled alarm once each", async ({ runtime }) => {
          await runtime.drainAlarms();
          await runtime.drainAlarms();
          await runtime.drainAlarms();

          expect(alarmCalls).toBe(2);
        }),
      ],
    }),
  );
});

test("detached alarm work observes live logical time after the drain ends", async () => {
  const releaseDetachedWork = createVoidDeferred();
  let alarmTime = 0;
  let detachedTime: Promise<number> | null = null;

  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "detached alarm work observes live logical time after the drain ends",
      options: { drain: false },
      objectFactories: {
        UPLOAD: ({ state, nowEpochMs }) => ({
          async fetch() {
            await state.storage.setAlarm(nowEpochMs());
            return new Response(null, { status: 204 });
          },
          async alarm() {
            alarmTime = nowEpochMs();
            detachedTime = releaseDetachedWork.promise.then(() => nowEpochMs());
          },
        }),
      },
      steps: ({ then }) => [
        then.assert("schedule and deliver the alarm", async ({ runtime }) => {
          await runtime.objects.upload
            .forOrg("org-1")
            .http.fetch(new Request("https://backoffice.example/schedule"));
          await runtime.drainAlarms();
        }),
        then.assert("release detached work after advancing logical time", async ({ runtime }) => {
          const observedTime = detachedTime;
          assert(observedTime);
          const advancedTime = runtime.advanceTime(60_000);
          releaseDetachedWork.resolve();

          expect(await observedTime).toBeGreaterThanOrEqual(advancedTime);
          expect(advancedTime).toBeGreaterThan(alarmTime);
        }),
      ],
    }),
  );
});
