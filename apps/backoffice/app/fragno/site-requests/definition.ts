import type {
  ArtifactSiteLogEntry,
  ArtifactSiteVisitedLogEntry,
  ArtifactSiteVisitEvent,
} from "@fragno-dev/backoffice-api/v0/artifacts";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import type { SiteEvent } from "@/artifacts/sites/site-events";
import { isSiteLogError, SITE_LOG_LIMITS, type SiteLinkVisit } from "@/artifacts/sites/site-logs";

import {
  SITE_REQUEST_AT_INDEX,
  SITE_REQUEST_ORDER_INDEX,
  SITE_VISIT_EVENT_AT_INDEX,
  SITE_VISIT_EVENT_ORDER_INDEX,
  siteRequestsFragmentSchema,
} from "./schema";

/** Expired rows one record deletes; the next records delete the rest. */
const SITE_REQUEST_EXPIRY_BATCH_SIZE = 100;

/**
 * The rows a site drops to keep its latest `SITE_LOG_LIMITS.entriesPerSite` once `adding` more
 * arrive, with those past a day; a row can be both.
 */
function droppedRows<T extends { externalId: string }>(
  kept: readonly { id: T }[],
  expired: readonly { id: T }[],
  adding: number,
): T[] {
  const overflow = kept.slice(
    0,
    Math.max(0, kept.length + adding - SITE_LOG_LIMITS.entriesPerSite),
  );
  return [
    ...new Map([...overflow, ...expired].map(({ id }) => [id.externalId, id] as const)).values(),
  ];
}

/** The earliest time a read returns: `since`, but never past a day. */
function readFrom(since: Date | null, now: Date): number {
  return Math.max(since?.getTime() ?? 0, now.getTime() - SITE_LOG_LIMITS.keptMs);
}

/**
 * Keeps each site's latest requests, and the events its links' visits kept, for a day. Callers pass
 * the time, so what is kept does not depend on the database's clock.
 */
export const siteRequestsFragmentDefinition = defineFragment("site-requests")
  .extend(withDatabase(siteRequestsFragmentSchema))
  .providesBaseService(({ defineService }) =>
    defineService({
      /**
       * Keeps `entries`, which a link's `visit` made, if any, and drops what a site has beyond its
       * latest requests or past a day.
       */
      recordSiteRequests: function (input: {
        site: string;
        entries: ArtifactSiteLogEntry[];
        visit: SiteLinkVisit | null;
        now: Date;
      }) {
        const entries = input.entries.slice(-SITE_LOG_LIMITS.entriesPerSite);
        const expiredBefore = new Date(input.now.getTime() - SITE_LOG_LIMITS.keptMs);
        return this.serviceTx(siteRequestsFragmentSchema)
          .retrieve((uow) =>
            uow
              .find("site_request", (b) =>
                b
                  .whereIndex(SITE_REQUEST_ORDER_INDEX, (eb) => eb("site", "=", input.site))
                  .orderByIndex(SITE_REQUEST_ORDER_INDEX, "asc")
                  .select(["id", "sequence"]),
              )
              .find("site_request", (b) =>
                b
                  .whereIndex(SITE_REQUEST_AT_INDEX, (eb) => eb("at", "<", expiredBefore))
                  .pageSize(SITE_REQUEST_EXPIRY_BATCH_SIZE)
                  .select(["id"]),
              ),
          )
          .mutate(({ uow, retrieveResult: [kept, expired] }) => {
            const dropped = droppedRows(kept, expired, entries.length);
            if (dropped.length > 0) {
              uow.deleteMany("site_request", dropped);
            }
            const last = kept.at(-1)?.sequence ?? 0;
            for (const [index, entry] of entries.entries()) {
              uow.create(
                "site_request",
                {
                  site: input.site,
                  sequence: last + index + 1,
                  at: new Date(entry.at),
                  entry,
                  link: input.visit?.link ?? null,
                  visit: input.visit?.visit ?? null,
                },
                // A concurrent record took the sequence; a retry reads it and follows it.
                { retryOnUniqueConflict: () => true },
              );
            }
          })
          .build();
      },

      /** The site's latest `limit` requests from `since`, of `link`'s visits when given, oldest first. */
      readSiteRequests: function (input: {
        site: string;
        since: Date | null;
        link: string | null;
        errorsOnly: boolean;
        limit: number;
        now: Date;
      }) {
        const from = readFrom(input.since, input.now);
        // A site keeps at most `SITE_LOG_LIMITS.entriesPerSite` requests, so they are read whole.
        return this.serviceTx(siteRequestsFragmentSchema)
          .retrieve((uow) =>
            uow.find("site_request", (b) =>
              b
                .whereIndex(SITE_REQUEST_ORDER_INDEX, (eb) => eb("site", "=", input.site))
                .orderByIndex(SITE_REQUEST_ORDER_INDEX, "asc"),
            ),
          )
          .transformRetrieve(([requests]): ArtifactSiteVisitedLogEntry[] =>
            requests
              .filter(
                ({ at, entry, link }) =>
                  at.getTime() >= from &&
                  (input.link === null || link === input.link) &&
                  (!input.errorsOnly || isSiteLogError(entry)),
              )
              .slice(-input.limit)
              .map(({ entry, visit }) => ({ ...entry, visit })),
          )
          .build();
      },

      /** Keeps an event a link's visit kept, and drops what a site has beyond its latest or past a day. */
      recordSiteVisitEvent: function (input: {
        site: string;
        visit: SiteLinkVisit;
        event: SiteEvent;
        now: Date;
      }) {
        const expiredBefore = new Date(input.now.getTime() - SITE_LOG_LIMITS.keptMs);
        return this.serviceTx(siteRequestsFragmentSchema)
          .retrieve((uow) =>
            uow
              .find("site_visit_event", (b) =>
                b
                  .whereIndex(SITE_VISIT_EVENT_ORDER_INDEX, (eb) => eb("site", "=", input.site))
                  .orderByIndex(SITE_VISIT_EVENT_ORDER_INDEX, "asc")
                  .select(["id", "sequence"]),
              )
              .find("site_visit_event", (b) =>
                b
                  .whereIndex(SITE_VISIT_EVENT_AT_INDEX, (eb) => eb("at", "<", expiredBefore))
                  .pageSize(SITE_REQUEST_EXPIRY_BATCH_SIZE)
                  .select(["id"]),
              ),
          )
          .mutate(({ uow, retrieveResult: [kept, expired] }) => {
            const dropped = droppedRows(kept, expired, 1);
            if (dropped.length > 0) {
              uow.deleteMany("site_visit_event", dropped);
            }
            uow.create(
              "site_visit_event",
              {
                site: input.site,
                sequence: (kept.at(-1)?.sequence ?? 0) + 1,
                at: input.now,
                link: input.visit.link,
                visit: input.visit.visit,
                event: input.event,
              },
              { retryOnUniqueConflict: () => true },
            );
          })
          .build();
      },

      /** The events `link`'s visits kept on the site within a day, oldest first. */
      readSiteVisitEvents: function (input: { site: string; link: string; now: Date }) {
        const from = readFrom(null, input.now);
        return this.serviceTx(siteRequestsFragmentSchema)
          .retrieve((uow) =>
            uow.find("site_visit_event", (b) =>
              b
                .whereIndex(SITE_VISIT_EVENT_ORDER_INDEX, (eb) => eb("site", "=", input.site))
                .orderByIndex(SITE_VISIT_EVENT_ORDER_INDEX, "asc"),
            ),
          )
          .transformRetrieve(([events]): ArtifactSiteVisitEvent[] =>
            events
              .filter(({ at, link }) => at.getTime() >= from && link === input.link)
              .map(({ visit, at, event }) => ({ visit, at: at.toISOString(), ...event })),
          )
          .build();
      },
    }),
  )
  .build();
