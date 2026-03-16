import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const otpSchema = schema("otp", (s) => {
  return s.addTable("otp", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("userId", column("string"))
      .addColumn("type", column("string"))
      .addColumn("code", column("string"))
      .addColumn("status", column("string"))
      .addColumn("expiresAt", column("timestamp"))
      .addColumn("confirmedAt", column("timestamp").nullable())
      .addColumn("expiredAt", column("timestamp").nullable())
      .addColumn("invalidatedAt", column("timestamp").nullable())
      .addColumn(
        "createdAt",
        column("timestamp").defaultTo((b) => b.now()),
      )
      .createIndex("idx_otp_user_type_status", ["userId", "type", "status"])
      .createIndex("idx_otp_status_expiresAt", ["status", "expiresAt"])
      .createIndex("idx_otp_id_status_expiresAt", ["id", "status", "expiresAt"])
      .createIndex("idx_otp_user_type_status_code_expiresAt", [
        "userId",
        "type",
        "status",
        "code",
        "expiresAt",
      ])
      .createIndex("idx_otp_user_type_createdAt", ["userId", "type", "createdAt"]);
  });
});
