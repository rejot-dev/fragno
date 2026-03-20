import { z } from "zod";

import type { ResendRouteFactoryContext } from "./context";
import { buildDomainDetail, buildDomainSummary } from "./shared";

const resendDomainCapabilityStatusSchema = z.enum(["enabled", "disabled"]);
const resendDomainStatusSchema = z.enum([
  "pending",
  "verified",
  "failed",
  "temporary_failure",
  "not_started",
]);
const resendDomainRegionSchema = z.enum(["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"]);

export const resendDomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: resendDomainStatusSchema,
  createdAt: z.string(),
  region: resendDomainRegionSchema,
  capabilities: z.object({
    sending: resendDomainCapabilityStatusSchema,
    receiving: resendDomainCapabilityStatusSchema,
  }),
});

export const resendDomainRecordSchema = z.object({
  record: z.enum(["SPF", "DKIM", "Receiving"]),
  name: z.string(),
  value: z.string(),
  type: z.enum(["MX", "TXT", "CNAME"]),
  ttl: z.string(),
  status: resendDomainStatusSchema,
  routingPolicy: z.string().optional(),
  priority: z.number().optional(),
  proxyStatus: z.enum(["enable", "disable"]).optional(),
});

export const resendListDomainsOutputSchema = z.object({
  domains: z.array(resendDomainSchema),
  hasMore: z.boolean(),
});

export const resendDomainDetailSchema = resendDomainSchema.extend({
  records: z.array(resendDomainRecordSchema),
});

export type ResendDomain = z.infer<typeof resendDomainSchema>;
export type ResendDomainRecord = z.infer<typeof resendDomainRecordSchema>;
export type ResendDomainDetail = z.infer<typeof resendDomainDetailSchema>;
export type ResendListDomainsOutput = z.infer<typeof resendListDomainsOutputSchema>;

export const registerDomainRoutes = ({ defineRoute, deps }: ResendRouteFactoryContext) => [
  defineRoute({
    method: "GET",
    path: "/domains",
    outputSchema: resendListDomainsOutputSchema,
    errorCodes: ["RESEND_API_ERROR"] as const,
    handler: async function (_input, { json, error }) {
      try {
        const response = await deps.resend.domains.list({ limit: 100 });

        if (response.error) {
          return error(
            {
              message: response.error.message,
              code: "RESEND_API_ERROR",
            },
            502,
          );
        }

        if (!response.data) {
          return error(
            {
              message: "Resend returned no domain data.",
              code: "RESEND_API_ERROR",
            },
            502,
          );
        }

        return json({
          domains: response.data.data.map((domain) => buildDomainSummary(domain)),
          hasMore: response.data.has_more,
        });
      } catch (err) {
        return error(
          {
            message: err instanceof Error ? err.message : String(err),
            code: "RESEND_API_ERROR",
          },
          502,
        );
      }
    },
  }),
  defineRoute({
    method: "GET",
    path: "/domains/:domainId",
    outputSchema: resendDomainDetailSchema,
    errorCodes: ["DOMAIN_NOT_FOUND", "RESEND_API_ERROR"] as const,
    handler: async function ({ pathParams }, { json, error }) {
      try {
        const response = await deps.resend.domains.get(pathParams.domainId);

        if (response.error) {
          if (response.error.name === "not_found") {
            return error(
              {
                message: "Domain not found.",
                code: "DOMAIN_NOT_FOUND",
              },
              404,
            );
          }

          return error(
            {
              message: response.error.message,
              code: "RESEND_API_ERROR",
            },
            502,
          );
        }

        if (!response.data) {
          return error(
            {
              message: "Resend returned no domain detail.",
              code: "RESEND_API_ERROR",
            },
            502,
          );
        }

        return json(buildDomainDetail(response.data));
      } catch (err) {
        return error(
          {
            message: err instanceof Error ? err.message : String(err),
            code: "RESEND_API_ERROR",
          },
          502,
        );
      }
    },
  }),
];
