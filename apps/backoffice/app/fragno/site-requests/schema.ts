import type { ArtifactSiteLogEntry } from "@fragno-dev/backoffice-api/v0/artifacts";
import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

export const SITE_REQUEST_ORDER_INDEX = "idx_site_request_site_sequence";
export const SITE_REQUEST_AT_INDEX = "idx_site_request_at";

/** The requests a scope's sites handled that logged, threw, exceeded a limit, or answered 5xx. */
export const siteRequestsFragmentSchema = schema("site-requests", (s) =>
  s.addTable("site_request", (t) =>
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
  ),
);
