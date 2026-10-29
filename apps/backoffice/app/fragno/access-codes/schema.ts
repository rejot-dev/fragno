import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const ACCESS_CODE_ORDER_INDEX = "idx_access_code_createdAt_id";
export const ACCESS_CODE_REDEMPTION_ORDER_INDEX = "idx_access_code_redemption_code_redeemedAt_id";

/**
 * Codes that admit new Backoffice accounts. They are kept readable, so administrators can share a
 * link again; revoking and expiry are what contain a code that spread too far.
 */
export const accessCodesFragmentSchema = schema("access-codes", (s) =>
  s
    .addTable("access_code", (t) =>
      t
        .addColumn("id", idColumn())
        // In canonical form, as `normalizeAccessCode` writes it.
        .addColumn("code", column("string"))
        .addColumn("label", column("string"))
        // Null codes never expire.
        .addColumn("expiresAt", column("timestamp").nullable())
        .addColumn("revokedAt", column("timestamp").nullable())
        // The number of `access_code_redemption` rows for this code, kept with every redemption so
        // a page of codes shows its counts without reading the redemptions.
        .addColumn("redemptionCount", column("integer").defaultTo(0))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_access_code_code", ["code"], { unique: true })
        .createIndex(ACCESS_CODE_ORDER_INDEX, ["createdAt", "id"]),
    )
    // One row per account a code admitted. Better Auth asks before it creates the user, so the
    // account is known by its email; a sign-up that fails after that leaves its row behind.
    .addTable("access_code_redemption", (t) =>
      t
        .addColumn("id", idColumn())
        // Codes are unique and never change, so a redemption names its code by value: redeeming
        // looks the code and its redemption up together.
        .addColumn("code", column("string"))
        .addColumn("email", column("string"))
        .addColumn("redeemedAt", column("timestamp"))
        .createIndex("idx_access_code_redemption_code_email", ["code", "email"], { unique: true })
        .createIndex(ACCESS_CODE_REDEMPTION_ORDER_INDEX, ["code", "redeemedAt", "id"]),
    ),
);
