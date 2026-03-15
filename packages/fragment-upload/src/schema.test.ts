import { beforeEach, describe, expect, it } from "vitest";

import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { uploadSchema } from "./schema";

describe("uploadSchema", async () => {
  const definition = defineFragment("upload-test").extend(withDatabase(uploadSchema)).build();

  const { fragments, test: testContext } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "drizzle-pglite" })
    .withFragment("upload-test", instantiate(definition))
    .build();

  const { fragment } = fragments["upload-test"];

  beforeEach(async () => {
    await testContext.resetDatabase();
  });

  it("stores file, upload, and upload_part rows", async () => {
    const result = await fragment.inContext(function () {
      return this.handlerTx()
        .mutate(({ forSchema }) => {
          const uow = forSchema(uploadSchema);
          const fileKey = "users/1/avatar";
          const timestamp = new Date();
          const provider = "test";
          const objectKey = "uploads/test/users/1/avatar";

          const fileId = uow.create("file", {
            key: fileKey,
            provider,
            uploaderId: null,
            filename: "avatar.png",
            sizeBytes: 1024n,
            contentType: "image/png",
            checksum: { algo: "sha256", value: "deadbeef" },
            visibility: "private",
            tags: ["profile"],
            metadata: { purpose: "test" },
            status: "ready",
            objectKey,
            createdAt: timestamp,
            updatedAt: timestamp,
            completedAt: null,
            deletedAt: null,
            errorCode: null,
            errorMessage: null,
          });

          const uploadId = uow.create("upload", {
            key: fileKey,
            provider,
            uploaderId: null,
            filename: "avatar.png",
            expectedSizeBytes: 1024n,
            contentType: "image/png",
            checksum: { algo: "sha256", value: "deadbeef" },
            visibility: "private",
            tags: ["profile"],
            metadata: { purpose: "test" },
            status: "created",
            strategy: "proxy",
            objectKey,
            storageUploadId: null,
            uploadUrl: null,
            uploadHeaders: null,
            bytesUploaded: 0n,
            partsUploaded: 0,
            partSizeBytes: null,
            expiresAt: new Date(Date.now() + 60_000),
            createdAt: timestamp,
            updatedAt: timestamp,
            completedAt: null,
            errorCode: null,
            errorMessage: null,
          });

          const partId = uow.create("upload_part", {
            uploadId,
            partNumber: 1,
            etag: "etag-1",
            sizeBytes: 512n,
            createdAt: timestamp,
          });

          return {
            fileId: fileId.valueOf(),
            uploadId: uploadId.valueOf(),
            partId: partId.valueOf(),
          };
        })
        .execute();
    });

    expect(result).toEqual({
      fileId: expect.any(String),
      uploadId: expect.any(String),
      partId: expect.any(String),
    });
  });
});
