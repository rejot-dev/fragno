import type { ArtifactSiteLogEntry } from "@fragno-dev/backoffice-api/v0/artifacts";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import { isSiteLogError, SITE_LOG_LIMITS } from "@/artifacts/sites/site-logs";

import {
  SITE_REQUEST_AT_INDEX,
  SITE_REQUEST_ORDER_INDEX,
  siteRequestsFragmentSchema,
} from "./schema";

/** Expired requests one record deletes; the next records delete the rest. */
const SITE_REQUEST_EXPIRY_BATCH_SIZE = 100;

/**
 * Keeps each site's latest requests for a day. Callers pass the time, so what is kept does not
 * depend on the database's clock.
 */
export const siteRequestsFragmentDefinition = defineFragment("site-requests")
  .extend(withDatabase(siteRequestsFragmentSchema))
  .providesBaseService(({ defineService }) =>
    defineService({
      /** Keeps `entries`, and drops what a site has beyond its latest requests or past a day. */
      recordSiteRequests: function (input: {
        site: string;
        entries: ArtifactSiteLogEntry[];
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
            const overflow = kept.slice(
              0,
              Math.max(0, kept.length + entries.length - SITE_LOG_LIMITS.entriesPerSite),
            );
            // A request can be both expired and beyond its site's latest.
            const dropped = new Map(
              [...overflow, ...expired].map(({ id }) => [id.externalId, id] as const),
            );
            if (dropped.size > 0) {
              uow.deleteMany("site_request", [...dropped.values()]);
            }
            const last = kept.at(-1)?.sequence ?? 0;
            for (const [index, entry] of entries.entries()) {
              uow.create(
                "site_request",
                { site: input.site, sequence: last + index + 1, at: new Date(entry.at), entry },
                // A concurrent record took the sequence; a retry reads it and follows it.
                { retryOnUniqueConflict: () => true },
              );
            }
          })
          .build();
      },

      /** The site's latest `limit` requests from `since`, oldest first. */
      readSiteRequests: function (input: {
        site: string;
        since: Date | null;
        errorsOnly: boolean;
        limit: number;
        now: Date;
      }) {
        const from = Math.max(
          input.since?.getTime() ?? 0,
          input.now.getTime() - SITE_LOG_LIMITS.keptMs,
        );
        // A site keeps at most `SITE_LOG_LIMITS.entriesPerSite` requests, so they are read whole.
        return this.serviceTx(siteRequestsFragmentSchema)
          .retrieve((uow) =>
            uow.find("site_request", (b) =>
              b
                .whereIndex(SITE_REQUEST_ORDER_INDEX, (eb) => eb("site", "=", input.site))
                .orderByIndex(SITE_REQUEST_ORDER_INDEX, "asc"),
            ),
          )
          .transformRetrieve(([requests]) =>
            requests
              .filter(
                ({ at, entry }) =>
                  at.getTime() >= from && (!input.errorsOnly || isSiteLogError(entry)),
              )
              .slice(-input.limit)
              .map(({ entry }) => entry),
          )
          .build();
      },
    }),
  )
  .build();
