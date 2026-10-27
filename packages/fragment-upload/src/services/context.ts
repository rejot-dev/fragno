import type { DatabaseServiceContext, HookFn, TypedUnitOfWork } from "@fragno-dev/db";

import type { FileHookPayload, UnfinishedUploadPayload, UploadTimeoutPayload } from "../config";
import type { uploadSchema } from "../schema";

export type UploadHooks = {
  onFileReady: HookFn<FileHookPayload>;
  onFileTextIndexRequested: HookFn<FileHookPayload>;
  onUploadFailed: HookFn<FileHookPayload>;
  onFileDeleted: HookFn<FileHookPayload>;
  cleanupStorageObject: HookFn<FileHookPayload>;
  cleanupUnfinishedUpload: HookFn<UnfinishedUploadPayload>;
  onUploadTimeout: HookFn<UploadTimeoutPayload>;
};

export type UploadServiceContext = DatabaseServiceContext<UploadHooks>;

export type UploadMutationUnitOfWork = TypedUnitOfWork<
  typeof uploadSchema,
  unknown[],
  unknown,
  UploadHooks
>;
