/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";

import { env } from "cloudflare:workers";

describe("Durable Object alarm repro", () => {
  afterEach(async () => {
    await reset();
  });

  test("Durable Object Facet storage.setAlarm fails in the Cloudflare Vitest pool", async () => {
    const host = env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName("alarm-facet-repro-host"));

    await expect(
      runInDurableObject(host, async (_instance, state) => {
        const worker = env.LOADER.get("alarm-facet-repro-worker", () => ({
          mainModule: "index.js",
          modules: {
            "index.js": `
              import { DurableObject } from "cloudflare:workers";

              export class AlarmFacet extends DurableObject {
                async fetch() {
                  await this.ctx.storage.setAlarm(Date.now());
                  return Response.json({ ok: true });
                }

                async alarm() {}
              }
            `,
          },
          compatibilityDate: "2026-05-07",
        }));
        const facet = state.facets.get("alarm-facet-repro", () => ({
          class: worker.getDurableObjectClass("AlarmFacet"),
          id: "alarm-facet-repro",
        }));

        await facet.fetch("https://alarm-facet-repro.test/");
      }),
    ).rejects.toThrow("alarms are not yet implemented for SQLite-backed Durable Objects");
  });

  test("a facet alarm can be proxied through the parent Durable Object alarm", async () => {
    const host = env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName("alarm-facet-workaround-host"));
    const facetName = "alarm-facet-workaround-worker";
    const parentFacetAlarmKey = `__facet_alarm__:${facetName}`;

    const scheduled = await runInDurableObject(host, async (_instance, state) => {
      const worker = env.LOADER.get("alarm-facet-workaround-worker", () => ({
        mainModule: "index.js",
        modules: {
          "index.js": `
            import { DurableObject } from "cloudflare:workers";

            const facetAlarmKey = "proxied-alarm-time";
            const toAlarmTime = (value) => value instanceof Date ? value.getTime() : value;

            const installAlarmProxy = (state) => {
              const storage = state.storage;
              storage.setAlarm = async (scheduledTime) => {
                await storage.put(facetAlarmKey, toAlarmTime(scheduledTime));
              };
            };

            export class AlarmFacet extends DurableObject {
              constructor(state, env) {
                super(state, env);
                installAlarmProxy(state);
              }

              async fetch(request) {
                const url = new URL(request.url);
                if (url.pathname === "/__automation-workflow/alarm-state") {
                  return Response.json({ alarmTime: await this.ctx.storage.get(facetAlarmKey) ?? null });
                }
                if (url.pathname === "/__automation-workflow/alarm") {
                  await this.ctx.storage.delete(facetAlarmKey);
                  await this.alarm();
                  return Response.json({ ok: true });
                }
                if (url.pathname === "/status") {
                  return Response.json({ alarmFired: await this.ctx.storage.get("alarm-fired") ?? false });
                }

                await this.ctx.storage.put("alarm-fired", false);
                await this.ctx.storage.setAlarm(Date.now());
                return Response.json({ alarmTime: await this.ctx.storage.get(facetAlarmKey) });
              }

              async alarm() {
                await this.ctx.storage.put("alarm-fired", true);
              }
            }
          `,
        },
        compatibilityDate: "2026-05-07",
      }));
      const facet = state.facets.get(facetName, () => ({
        class: worker.getDurableObjectClass("AlarmFacet"),
        id: facetName,
      }));

      const scheduleResponse = await facet.fetch("https://alarm-facet-workaround.test/");
      const scheduleResult = (await scheduleResponse.json()) as { alarmTime: number };

      await state.storage.put(parentFacetAlarmKey, scheduleResult.alarmTime);
      await state.storage.setAlarm(scheduleResult.alarmTime);

      return {
        alarmTime: scheduleResult.alarmTime,
        alarmFired: await facet
          .fetch("https://alarm-facet-workaround.test/status")
          .then((response) => response.json()),
      };
    });

    expect(scheduled).toMatchObject({
      alarmTime: expect.any(Number),
      alarmFired: { alarmFired: false },
    });

    await runDurableObjectAlarm(host);

    const delivered = await runInDurableObject(host, async (_instance, state) => {
      const worker = env.LOADER.get("alarm-facet-workaround-worker", async () => {
        throw new Error("Expected cached alarm workaround worker.");
      });
      const facet = state.facets.get(facetName, () => ({
        class: worker.getDurableObjectClass("AlarmFacet"),
        id: facetName,
      }));

      return {
        alarmFired: await facet
          .fetch("https://alarm-facet-workaround.test/status")
          .then((response) => response.json()),
        parentFacetAlarm: await state.storage.get(parentFacetAlarmKey),
      };
    });

    expect(delivered).toEqual({
      alarmFired: { alarmFired: true },
      parentFacetAlarm: undefined,
    });
  });
});
