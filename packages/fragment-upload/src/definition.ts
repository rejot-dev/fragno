import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { UploadFragmentConfig } from "./config";
import { resolveUploadFragmentConfig } from "./config";
import { uploadSchema } from "./schema";
import { createFileServices, createUploadServices } from "./services";

export const uploadFragmentDefinition = defineFragment<UploadFragmentConfig>("upload")
  .extend(withDatabase(uploadSchema))
  .withDependencies(({ config }) => ({
    resolvedConfig: resolveUploadFragmentConfig(config),
  }))
  .provideHooks(({ defineHook, config }) => ({
    onFileReady: defineHook(async function (payload) {
      await config.onFileReady?.(payload, this.idempotencyKey);
    }),
    onUploadFailed: defineHook(async function (payload) {
      await config.onUploadFailed?.(payload, this.idempotencyKey);
    }),
    onFileDeleted: defineHook(async function (payload) {
      await config.onFileDeleted?.(payload, this.idempotencyKey);
    }),
  }))
  .providesBaseService(({ defineService, deps }) => {
    return defineService({
      ...createUploadServices(deps.resolvedConfig),
      ...createFileServices(deps.resolvedConfig),
    });
  })
  .build();
