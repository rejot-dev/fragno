import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const otpSchema = schema("otp", (s) => {
  return s.addTable("otp", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("externalId", column("string"))
      .addColumn("type", column("string"))
      .addColumn("code", column("string"))
      .addColumn("status", column("string"))
      .addColumn("expiresAt", column("timestamp"))
      .addColumn("payload", column("json").nullable())
      .addColumn("confirmedAt", column("timestamp").nullable())
      .addColumn("expiredAt", column("timestamp").nullable())
      .addColumn("invalidatedAt", column("timestamp").nullable())
      .addColumn(
        "createdAt",
        column("timestamp").defaultTo((b) => b.now()),
      )
      .createIndex("idx_otp_externalId_type_status", ["externalId", "type", "status"])
      .createIndex("idx_otp_status_expiresAt", ["status", "expiresAt"])
      .createIndex("idx_otp_id_status_expiresAt", ["id", "status", "expiresAt"])
      .createIndex("idx_otp_externalId_type_status_code_expiresAt", [
        "externalId",
        "type",
        "status",
        "code",
        "expiresAt",
      ])
      .createIndex("idx_otp_externalId_type_createdAt", ["externalId", "type", "createdAt"]);
  });
});
