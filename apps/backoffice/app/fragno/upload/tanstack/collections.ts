import { uploadSchema } from "@fragno-dev/upload/schema";

import {
  type FragnoCollectionRow,
  type FragnoOutboxCoordinator,
} from "@fragno-dev/tanstack-db-adapter";

import type { Collection } from "@tanstack/react-db";

export type UploadCollections = {
  files: Collection<FragnoCollectionRow<(typeof uploadSchema.tables)["file"]>, string>;
};

/** Only metadata needed by the file explorer is eligible for browser synchronization. */
export type UploadCollectionTarget = "file";

export function createUploadCollections(
  coordinator: FragnoOutboxCoordinator<readonly [typeof uploadSchema]>,
): UploadCollections {
  return {
    files: coordinator.collection(uploadSchema, "file"),
  };
}
