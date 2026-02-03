import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const mailingListSchema = schema("mailing-list", (s) => {
  return s.addTable("subscriber", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("email", column("string"))
      .addColumn(
        "subscribedAt",
        column("timestamp").defaultTo((b) => b.now()),
      )
      .createIndex("idx_subscriber_email", ["email"])
      .createIndex("idx_subscriber_subscribedAt", ["subscribedAt"]);
  });
});
