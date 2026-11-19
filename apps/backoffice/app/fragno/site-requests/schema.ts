import type { ArtifactSiteLogEntry } from "@fragno-dev/backoffice-api/v0/artifacts";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { SiteEvent } from "@/artifacts/sites/site-events";

export const SITE_REQUEST_ORDER_INDEX = "idx_site_request_site_sequence";
export const SITE_REQUEST_AT_INDEX = "idx_site_request_at";
export const SITE_VISIT_EVENT_ORDER_INDEX = "idx_site_visit_event_site_sequence";
export const SITE_VISIT_EVENT_AT_INDEX = "idx_site_visit_event_at";

/**
 * The requests a scope's sites handled that logged, threw, exceeded a limit, or answered 5xx, and
 * every request of a site link's visits, with the events those visits' Workers kept.
 */
export const siteRequestsFragmentSchema = schema("site-requests", (s) =>
  s
    .addTable("site_request", (t) =>
      t
        .addColumn("id", idColumn())
        // The site's workspace path, such as `/workspace/shop.site`.
        .addColumn("site", column("string"))
        // The request's place among its site's requests, from 1; requests may start in one
        // millisecond, so this, not `at`, orders them.
        .addColumn("sequence", column("integer"))
        // When the request started, which retention counts from.
        .addColumn("at", column("timestamp"))
        .addColumn(
          "entry",
          column("json") as Column<"json", ArtifactSiteLogEntry, ArtifactSiteLogEntry>,
        )
        .createIndex(SITE_REQUEST_ORDER_INDEX, ["site", "sequence"], { unique: true })
        .createIndex(SITE_REQUEST_AT_INDEX, ["at"]),
    )
    .alterTable("site_request", (t) =>
      // The site link, and its visit, that made the request; null for anyone else's.
      t
        .addColumn("link", column("string").nullable())
        .addColumn("visit", column("string").nullable()),
    )
    .addTable("site_visit_event", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("site", column("string"))
        // Orders the site's kept events, as `site_request.sequence` orders its requests.
        .addColumn("sequence", column("integer"))
        .addColumn("at", column("timestamp"))
        .addColumn("link", column("string"))
        .addColumn("visit", column("string"))
        .addColumn("event", column("json") as Column<"json", SiteEvent, SiteEvent>)
        .createIndex(SITE_VISIT_EVENT_ORDER_INDEX, ["site", "sequence"], { unique: true })
        .createIndex(SITE_VISIT_EVENT_AT_INDEX, ["at"]),
    ),
);
