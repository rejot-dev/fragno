import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const uploadSchema = schema("upload", (s) => {
  return s
    .addTable("file", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("fileKey", column("string"))
        .addColumn("uploaderId", column("string").nullable())
        .addColumn("filename", column("string"))
        .addColumn("sizeBytes", column("bigint"))
        .addColumn("contentType", column("string"))
        .addColumn("checksum", column("json").nullable())
        .addColumn("visibility", column("string"))
        .addColumn("tags", column("json").nullable())
        .addColumn("metadata", column("json").nullable())
        .addColumn("status", column("string"))
        .addColumn("storageProvider", column("string"))
        .addColumn("storageKey", column("string"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("completedAt", column("timestamp").nullable())
        .addColumn("deletedAt", column("timestamp").nullable())
        .addColumn("errorCode", column("string").nullable())
        .addColumn("errorMessage", column("string").nullable())
        .createIndex("idx_file_key", ["fileKey"], { unique: true })
        .createIndex("idx_file_key_status", ["fileKey", "status"])
        .createIndex("idx_file_key_uploaderId", ["fileKey", "uploaderId"])
        .createIndex("idx_file_key_status_uploaderId", ["fileKey", "status", "uploaderId"])
        .createIndex("idx_file_uploaderId", ["uploaderId"])
        .createIndex("idx_file_createdAt", ["createdAt"])
        .createIndex("idx_file_status_createdAt", ["status", "createdAt"]);
    })
    .addTable("upload", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("fileKey", column("string"))
        .addColumn("uploaderId", column("string").nullable())
        .addColumn("filename", column("string"))
        .addColumn("expectedSizeBytes", column("bigint"))
        .addColumn("contentType", column("string"))
        .addColumn("checksum", column("json").nullable())
        .addColumn("visibility", column("string"))
        .addColumn("tags", column("json").nullable())
        .addColumn("metadata", column("json").nullable())
        .addColumn("status", column("string"))
        .addColumn("strategy", column("string"))
        .addColumn("storageProvider", column("string"))
        .addColumn("storageKey", column("string"))
        .addColumn("storageUploadId", column("string").nullable())
        .addColumn("uploadUrl", column("string").nullable())
        .addColumn("uploadHeaders", column("json").nullable())
        .addColumn("bytesUploaded", column("bigint").defaultTo(0n))
        .addColumn("partsUploaded", column("integer").defaultTo(0))
        .addColumn("partSizeBytes", column("integer").nullable())
        .addColumn("expiresAt", column("timestamp"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn(
          "updatedAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("completedAt", column("timestamp").nullable())
        .addColumn("errorCode", column("string").nullable())
        .addColumn("errorMessage", column("string").nullable())
        .createIndex("idx_upload_file_key", ["fileKey"])
        .createIndex("idx_upload_status", ["status"])
        .createIndex("idx_upload_expiresAt", ["expiresAt"]);
    })
    .addTable("upload_part", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("uploadId", referenceColumn())
        .addColumn("partNumber", column("integer"))
        .addColumn("etag", column("string"))
        .addColumn("sizeBytes", column("bigint"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_upload_part_upload", ["uploadId"])
        .createIndex("idx_upload_part_number", ["uploadId", "partNumber"], {
          unique: true,
        });
    })
    .addReference("upload", {
      type: "one",
      from: { table: "upload_part", column: "uploadId" },
      to: { table: "upload", column: "id" },
    });
});
