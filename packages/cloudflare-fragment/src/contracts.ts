import { z } from "zod";

export const SUPPORTED_DEPLOYMENT_FORMAT = "esmodule";
export const DEFAULT_DEPLOYMENT_ENTRYPOINT = "index.mjs";

export const cloudflareCompatibilityDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "compatibilityDate must use YYYY-MM-DD.");

export const cloudflareDeploymentStatusSchema = z.enum([
  "queued",
  "deploying",
  "succeeded",
  "failed",
]);

export const cloudflareDeployScriptSchema = z.object({
  type: z.enum([SUPPORTED_DEPLOYMENT_FORMAT]).default(SUPPORTED_DEPLOYMENT_FORMAT),
  entrypoint: z.string().trim().min(1).default(DEFAULT_DEPLOYMENT_ENTRYPOINT),
  content: z.string(),
});

export const cloudflareDeployRequestSchema = z.object({
  script: cloudflareDeployScriptSchema,
  compatibilityDate: cloudflareCompatibilityDateSchema.optional(),
  compatibilityFlags: z.array(z.string().min(1)).optional(),
});

const cloudflareTimestampSchema = z.string().datetime({ offset: true });

export const cloudflareProviderSummarySchema = z.object({
  etag: z.string().nullable(),
  modifiedOn: cloudflareTimestampSchema.nullable(),
});

export const cloudflareDeploymentSummarySchema = z.object({
  id: z.string(),
  appId: z.string(),
  scriptName: z.string(),
  status: cloudflareDeploymentStatusSchema,
  format: z.literal(SUPPORTED_DEPLOYMENT_FORMAT),
  entrypoint: z.string(),
  sourceByteLength: z.number().int().nonnegative(),
  compatibilityDate: cloudflareCompatibilityDateSchema,
  compatibilityFlags: z.array(z.string()),
  attemptCount: z.number().int().nonnegative(),
  queuedAt: cloudflareTimestampSchema,
  startedAt: cloudflareTimestampSchema.nullable(),
  completedAt: cloudflareTimestampSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  cloudflare: cloudflareProviderSummarySchema.nullable(),
  createdAt: cloudflareTimestampSchema,
  updatedAt: cloudflareTimestampSchema,
});

export const cloudflareDeploymentDetailSchema = cloudflareDeploymentSummarySchema.extend({
  sourceCode: z.string(),
});

export const cloudflareAppSummarySchema = z.object({
  id: z.string(),
  scriptName: z.string(),
  latestDeployment: cloudflareDeploymentSummarySchema.nullable(),
  createdAt: cloudflareTimestampSchema,
  updatedAt: cloudflareTimestampSchema,
});

export const cloudflareAppStateSchema = cloudflareAppSummarySchema.extend({
  liveDeployment: cloudflareDeploymentSummarySchema.nullable(),
  liveDeploymentError: z.string().nullable(),
  deployments: z.array(cloudflareDeploymentSummarySchema),
});

export const cloudflareAppListSchema = z.object({
  apps: z.array(cloudflareAppSummarySchema),
});

export const cloudflareDeploymentListSchema = z.object({
  deployments: z.array(cloudflareDeploymentSummarySchema),
});

export type CloudflareDeploymentStatus = z.infer<typeof cloudflareDeploymentStatusSchema>;
export type CloudflareDeployRequest = z.infer<typeof cloudflareDeployRequestSchema>;
export type CloudflareDeploymentSummary = z.infer<typeof cloudflareDeploymentSummarySchema>;
export type CloudflareDeploymentDetail = z.infer<typeof cloudflareDeploymentDetailSchema>;
export type CloudflareAppSummary = z.infer<typeof cloudflareAppSummarySchema>;
export type CloudflareAppState = z.infer<typeof cloudflareAppStateSchema>;
export type CloudflareAppList = z.infer<typeof cloudflareAppListSchema>;
export type CloudflareDeploymentList = z.infer<typeof cloudflareDeploymentListSchema>;
