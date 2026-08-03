import type {
  BrowserCreateParams,
  BrowserCreateResponse,
  BrowserDeleteResponse,
} from "cloudflare/resources/browser-rendering/devtools/browser/browser";
import type {
  TargetActivateResponse,
  TargetCloseResponse,
  TargetCreateParams,
  TargetCreateResponse,
  TargetGetResponse,
  TargetListResponse,
} from "cloudflare/resources/browser-rendering/devtools/browser/targets";
import type {
  SessionGetResponse,
  SessionListParams,
  SessionListResponse,
} from "cloudflare/resources/browser-rendering/devtools/session";
import { z } from "zod";

type WithoutAccountId<T> = T extends unknown ? Omit<T, "account_id"> : never;

export type BrowserRunSessionCreateInput = WithoutAccountId<BrowserCreateParams>;
export type BrowserRunSessionListInput = WithoutAccountId<SessionListParams>;
export type BrowserRunTargetCreateInput = WithoutAccountId<TargetCreateParams>;

export const browserRunSessionCreateInputSchema = z.object({
  keep_alive: z.number().int().min(10_000).max(1_200_000).optional(),
  lab: z.boolean().optional(),
  recording: z.boolean().optional(),
  targets: z.boolean().optional(),
}) satisfies z.ZodType<BrowserRunSessionCreateInput>;

export const browserRunSessionListQueryParameterNames = ["limit", "offset"] as const;

export const browserRunSessionListInputSchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<BrowserRunSessionListInput>;

export const browserRunTargetCreateInputSchema = z.object({
  url: z.url().optional(),
}) satisfies z.ZodType<BrowserRunTargetCreateInput>;

export const browserRunSessionCreateResultSchema = z.custom<BrowserCreateResponse>();
export const browserRunSessionListResultSchema = z.custom<SessionListResponse>();
export const browserRunSessionResultSchema = z.custom<SessionGetResponse>();
export const browserRunSessionCloseResultSchema = z.custom<BrowserDeleteResponse>();
export const browserRunTargetCreateResultSchema = z.custom<TargetCreateResponse>();
export const browserRunTargetListResultSchema = z.custom<TargetListResponse>();
export const browserRunTargetResultSchema = z.custom<TargetGetResponse>();
export const browserRunTargetActivateResultSchema = z.custom<TargetActivateResponse>();
export const browserRunTargetCloseResultSchema = z.custom<TargetCloseResponse>();
