import { afterAll, assert, describe, test } from "vitest";

import type { ArtifactSiteLogEntry } from "@fragno-dev/backoffice-api/v0/artifacts";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { siteRequestsFragmentDefinition } from "./definition";
import { siteRequestsFragmentSchema } from "./schema";

const DAY_MS = 24 * 60 * 60 * 1000;

function entry(path: string, at: number, status = 200): ArtifactSiteLogEntry {
  return {
    at: new Date(at).toISOString(),
    method: "GET",
    path,
    status,
    outcome: "ok",
    cpuMs: 1,
    wallMs: 2,
    logs: [{ level: "log", message: path }],
    exceptions: [],
  };
}

describe("site requests fragment", async () => {
  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "siteRequests",
      instantiate(siteRequestsFragmentDefinition).withConfig({}).withRoutes([]),
    )
    .build();
  const { fragment, services, db } = fragments.siteRequests;

  afterAll(async () => {
    await testContext.cleanup();
  });

  const record = async (site: string, entries: ArtifactSiteLogEntry[], now: number) =>
    await fragment.callServices(() =>
      services.recordSiteRequests({ site, entries, now: new Date(now) }),
    );
  const read = async (
    now: number,
    query: { site?: string; since?: number; errorsOnly?: boolean; limit?: number } = {},
  ) =>
    (
      await fragment.callServices(() =>
        services.readSiteRequests({
          site: query.site ?? "/workspace/a.site",
          since: query.since === undefined ? null : new Date(query.since),
          errorsOnly: query.errorsOnly ?? false,
          limit: query.limit ?? 1000,
          now: new Date(now),
        }),
      )
    ).map(({ path }) => path);
  /** The requests stored, whether or not a read would return them. */
  const stored = async () => {
    const uow = db
      .createUnitOfWork("count-site-requests")
      .forSchema(siteRequestsFragmentSchema)
      .find("site_request", (b) => b.whereIndex("primary").select(["id"]));
    await uow.executeRetrieve();
    return (await uow.retrievalPhase)[0].length;
  };

  test("a site keeps its latest 200 requests in the order they came, apart from other sites", async () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    // Requests may start in one millisecond.
    await record(
      "/workspace/a.site",
      Array.from({ length: 150 }, (_, index) => entry(`/a/${index}`, now)),
      now,
    );
    await record(
      "/workspace/a.site",
      Array.from({ length: 55 }, (_, index) => entry(`/a/${150 + index}`, now)),
      now,
    );
    await record("/workspace/b.site", [entry("/b", now)], now);

    const kept = await read(now);
    assert.equal(kept.length, 200);
    assert.deepEqual(kept.slice(0, 2), ["/a/5", "/a/6"]);
    assert.equal(kept.at(-1), "/a/204");
    assert.deepEqual(await read(now, { limit: 2 }), ["/a/203", "/a/204"]);
    assert.deepEqual(await read(now, { site: "/workspace/b.site" }), ["/b"]);
    assert.equal(await stored(), 201);
  });

  test("requests are kept for a day, and read from a time or by failure", async () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    await record(
      "/workspace/c.site",
      [entry("/old", now - DAY_MS - 1), entry("/ok", now - 1000), entry("/failed", now, 500)],
      now,
    );
    const site = "/workspace/c.site";

    assert.deepEqual(await read(now, { site }), ["/ok", "/failed"]);
    assert.deepEqual(await read(now, { site, since: now }), ["/failed"]);
    assert.deepEqual(await read(now, { site, errorsOnly: true }), ["/failed"]);

    // A day later, each record drops up to 100 expired requests of any site: here the 204 both
    // tests stored, which two records drop.
    const later = now + DAY_MS + 1;
    await record(site, [entry("/new", later)], later);
    assert.deepEqual(await read(later, { site }), ["/new"]);
    assert.equal(await stored(), 204 - 100 + 1);
    await record(site, [entry("/newer", later)], later);
    await record(site, [entry("/newest", later)], later);
    assert.equal(await stored(), 3);
    assert.deepEqual(await read(later, { site }), ["/new", "/newer", "/newest"]);
  });
});
