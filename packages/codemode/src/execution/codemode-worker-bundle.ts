import { z } from "zod";

import { CODEMODE_LIMITS } from "../codemode-limits";
import { createWorkerBundle } from "../compiler/worker-bundle";

/** Compiled guests use a host-owned runtime contract, never artifact-selected compatibility flags. */
export const CODEMODE_WORKER_RUNTIME = {
  compatibilityDate: "2026-05-07",
  compatibilityFlags: ["nodejs_compat"],
} as const;

/** Validates persisted and remotely supplied bundles before they reach the Worker Loader. */
export const codemodeWorkerBundleSchema = z
  .strictObject({
    mainModule: z.string().trim().min(1).max(1024),
    modules: z.record(z.string().min(1).max(1024), z.string()),
    runtime: z.strictObject({
      compatibilityDate: z.literal(CODEMODE_WORKER_RUNTIME.compatibilityDate),
      compatibilityFlags: z.tuple([z.literal(CODEMODE_WORKER_RUNTIME.compatibilityFlags[0])]),
    }),
  })
  .superRefine((bundle, context) => {
    if (!Object.hasOwn(bundle.modules, bundle.mainModule)) {
      context.addIssue({ code: "custom", message: "CODEMODE_BUNDLE_MAIN_MODULE_MISSING" });
    }
    const modules = Object.entries(bundle.modules);
    if (modules.length > CODEMODE_LIMITS.maxEntries) {
      context.addIssue({ code: "custom", message: "CODEMODE_BUNDLE_MODULE_LIMIT_EXCEEDED" });
    }
    if (modules.some(([name]) => name !== name.trim())) {
      context.addIssue({ code: "custom", message: "CODEMODE_BUNDLE_INVALID_MODULE_NAME" });
    }
    const bytes = modules.reduce(
      (size, [, source]) => size + new TextEncoder().encode(source).byteLength,
      0,
    );
    if (bytes > CODEMODE_LIMITS.maxBundleBytes) {
      context.addIssue({ code: "custom", message: "CODEMODE_BUNDLE_LIMIT_EXCEEDED" });
    }
  })
  .transform(createWorkerBundle);
