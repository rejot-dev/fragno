import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const otpSchema = schema((s) => {
  return s.addTable("otp_code", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("userId", column("string")) // Use string since we pass userId across service boundaries
      .addColumn("code", column("string"))
      .addColumn("expiresAt", column("timestamp"))
      .addColumn(
        "verified",
        column("bool").defaultTo(() => false),
      )
      .addColumn(
        "createdAt",
        column("timestamp").defaultTo((b) => b.now()),
      )
      .createIndex("idx_otp_user", ["userId"]);
  });
});

export const authSchema = schema((s) => {
  return s.addTable("user", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("email", column("string"))
      .addColumn("passwordHash", column("string"))
      .addColumn(
        "emailVerified",
        column("bool").defaultTo(() => false),
      )
      .addColumn(
        "createdAt",
        column("timestamp").defaultTo((b) => b.now()),
      )
      .createIndex("idx_user_email", ["email"]);
  });
});
