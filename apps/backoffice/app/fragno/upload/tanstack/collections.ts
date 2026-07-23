import type { FragnoOutboxCoordinator } from "@fragno-dev/tanstack-db-adapter/coordinator";
import { uploadSchema } from "@fragno-dev/upload/schema";

import type { FragnoCollection, FragnoCollectionFactory } from "@fragno-dev/tanstack-db-adapter";

export type UploadCollections = {
  files: FragnoCollection<typeof uploadSchema, "file">;
};

/** Only metadata needed by the file explorer is eligible for browser synchronization. */
export type UploadCollectionTarget = "file";

export function createUploadCollections(options: {
  coordinator: FragnoOutboxCoordinator;
  collectionId(target: UploadCollectionTarget): string;
  createCollection: FragnoCollectionFactory;
}): UploadCollections {
  return {
    files: options.createCollection({
      id: options.collectionId("file"),
      coordinator: options.coordinator,
      target: {
        schema: uploadSchema,
        table: "file",
      },
    }),
  };
}
