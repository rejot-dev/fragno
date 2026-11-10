import { assert, test } from "vitest";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";

import { createInMemorySiteEventLimiter } from "./site-event-limiter";
import {
  checkedSiteEvent,
  isSiteEventSource,
  siteEventSource,
  type SiteEvent,
} from "./site-events";
import { mayFireSiteEvents } from "./site-events.server";

const problemOf = (event: Partial<SiteEvent>) => {
  const checked = checkedSiteEvent({ type: "order.placed", payload: {}, viewer: null, ...event });
  return "problem" in checked ? checked.problem : null;
};

test("the host fires only events whose parts are what automations read", () => {
  assert.deepEqual(
    checkedSiteEvent({ type: " order.placed ", payload: { at: new Date(0) }, viewer: "viewer-1" }),
    {
      event: {
        type: "order.placed",
        payload: { at: "1970-01-01T00:00:00.000Z" },
        viewer: "viewer-1",
      },
    },
  );
  assert.equal(problemOf({ type: "" }), 'An event\'s type is text, such as "order.placed".');
  assert.equal(problemOf({ type: "x".repeat(201) }), "An event's type is at most 200 characters.");
  assert.equal(problemOf({ viewer: " " }), "An event's viewer is the viewer's id, or null.");
  assert.equal(problemOf({ payload: [] as never }), "An event's payload is an object.");
  assert.match(problemOf({ payload: { size: 1n } }) ?? "", /^An event's payload is JSON: /u);
  assert.equal(
    problemOf({ payload: { text: "x".repeat(64 * 1024) } }),
    "An event's payload is at most 64 KB of JSON.",
  );
});

test("sites fire from sources of their own", () => {
  assert.equal(siteEventSource("/workspace/shop.site"), "site:/workspace/shop.site");
  assert.isTrue(isSiteEventSource("site:/workspace/shop.site"));
  assert.isFalse(isSiteEventSource("app:shop"));
});

test("each viewer fires at most 60 events every 10 seconds", async () => {
  let now = 0;
  const limiter = createInMemorySiteEventLimiter(() => now);
  const fire = async (key: string, times: number) => {
    const allowed: boolean[] = [];
    for (let i = 0; i < times; i++) {
      allowed.push(await limiter.limit(key));
    }
    return allowed;
  };
  assert.deepEqual(new Set(await fire("viewer-1", 60)), new Set([true]));
  assert.deepEqual(await fire("viewer-1", 1), [false]);
  assert.deepEqual(await fire("viewer-2", 1), [true]);
  now = 9_999;
  assert.deepEqual(await fire("viewer-1", 1), [false]);
  now = 10_000;
  assert.deepEqual(await fire("viewer-1", 1), [true]);
});

test("a build fires unless its builder is denied events.emit, and fails when authority is down", async () => {
  const mayFire = (outcome: () => Promise<void>) =>
    mayFireSiteEvents({
      kernel: { assertAuthorizedAll: outcome },
      execution: createBackofficeSystemExecution({
        kind: "org",
        orgId: "org-1",
        jurisdiction: null,
      }),
      sitePath: "/workspace/shop.site",
    });
  assert.isTrue(await mayFire(async () => {}));
  for (const reason of ["principal-permission-denied", "actor-capability-denied"] as const) {
    assert.isFalse(
      await mayFire(async () => {
        throw new BackofficeForbiddenError("Not granted events.emit.", reason);
      }),
    );
  }
  const unavailable = new BackofficeForbiddenError(
    "Backoffice authority resolution is unavailable.",
    "authority-unavailable",
  );
  const failed = await mayFire(async () => {
    throw unavailable;
  }).catch((error: unknown) => error);
  assert.strictEqual(failed, unavailable);
});
