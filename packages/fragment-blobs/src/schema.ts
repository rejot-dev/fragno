import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const blobsSchema = schema("blobs", (s) => {
  return s
    .addTable("blob", (t) => {
      return (
        t
          .addColumn("id", idColumn())
          .addColumn("key", column("string"))
          // Every upload stores its bytes under a fresh object key, so replacing a blob never
          // overwrites the object an earlier download URL still reads.
          .addColumn("objectKey", column("string"))
          .addColumn("sizeBytes", column("bigint"))
          .addColumn("contentType", column("string"))
          .addColumn("etag", column("string"))
          .addColumn(
            "createdAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .addColumn(
            "updatedAt",
            column("timestamp").defaultTo((b) => b.now()),
          )
          .createIndex("idx_blob_key", ["key"], { unique: true })
      );
    })
    .addTable("blob_upload", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("key", column("string"))
        .addColumn("objectKey", column("string"))
        .addColumn("contentType", column("string"))
        .addColumn("expiresAt", column("timestamp"))
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .createIndex("idx_blob_upload_key", ["key"]);
    });
});
