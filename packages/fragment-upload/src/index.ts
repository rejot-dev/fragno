import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { createUploadFragmentClients } from "./client/clients";
import type { UploadFragmentConfig } from "./config";
import { uploadFragmentDefinition } from "./definition";
import { uploadRoutes } from "./routes";

export type { FileHookPayload, UploadFragmentConfig, UploadTimeoutPayload } from "./config";
export { uploadSchema } from "./schema";
export type {
  BuiltTextIndex,
  StateSearchOptions,
  StateTextMatch,
  TextIndexOptions,
  TextIndexTerm,
} from "./text-index";
export type { FileKey, FileKeyValidationResult, ValidateFileKeyOptions } from "./file-key";
export type { FileLinksConfig } from "./file-links";
export { assertFileKey, splitFileKey, validateFileKey } from "./file-key";
export {
  applyFileEditOperation,
  diffContent,
  type AppliedFileEdit,
  type ApplyFileEditsInput,
  type ApplyFileEditsResult,
  type FileEditOperation,
  type FileEditSearchOptions,
} from "./file-edits";
export type { UploadChecksum, UploadFileWritePrecondition } from "./types";
export type {
  CreateUploadAndTransferOptions,
  DownloadFileOptions,
  HydrateSearchMatchesResult,
  SearchCandidateCursor,
  SearchFileCandidate,
  SearchFileCandidatesResult,
  UploadHelpers,
  UploadProgress,
} from "./client/helpers";

export { uploadRoutes };

export function createUploadFragment(
  config: UploadFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(uploadFragmentDefinition)
    .withConfig(config)
    .withRoutes(uploadRoutes)
    .withOptions(options)
    .build();
}
export { createUploadFragmentClients };

export { uploadFragmentDefinition } from "./definition";
