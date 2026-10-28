import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { blobsFragmentDefinition, type BlobsFragmentConfig } from "./definition";
import { blobsRoutesFactory } from "./routes";

export type { BlobsFragmentConfig, StoredBlob } from "./definition";
export {
  createS3BlobStorage,
  type BlobStorage,
  type ObjectRange,
  type S3BlobStorageOptions,
  type S3Signer,
  type StoredObject,
} from "./storage";

export function createBlobsFragment(
  config: BlobsFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(blobsFragmentDefinition)
    .withConfig(config)
    .withRoutes([blobsRoutesFactory])
    .withOptions(options)
    .build();
}
