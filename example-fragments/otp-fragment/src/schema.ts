import { column, idColumn, schema, type Column } from "@fragno-dev/db/schema";

import type { OtpPayload, OtpStatus, OtpType } from "./types";

type OtpStringColumn<TValue extends string> = Column<"string", TValue, TValue>;
type OtpJsonColumn<TValue> = Column<"json", TValue, TValue>;

const otpStringColumn = <TValue extends string>(): OtpStringColumn<TValue> =>
  column("string") as OtpStringColumn<TValue>;

const otpJsonColumn = <TValue>(): OtpJsonColumn<TValue> =>
  column("json") as unknown as OtpJsonColumn<TValue>;

export const otpSchema = schema("otp", (s) => {
  return s.addTable("otp", (t) => {
    return t
      .addColumn("id", idColumn())
      .addColumn("externalId", column("string"))
      .addColumn("type", otpStringColumn<OtpType>())
      .addColumn("code", column("string"))
      .addColumn("status", otpStringColumn<OtpStatus>())
      .addColumn("expiresAt", column("timestamp"))
      .addColumn("payload", otpJsonColumn<OtpPayload>().nullable())
      .addColumn("confirmationPayload", otpJsonColumn<OtpPayload>().nullable())
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
