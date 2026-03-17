import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { otpFragmentDefinition } from "./definition";
import { otpTypeSchema } from "./types";

const dbNowSchema = z.object({
  tag: z.literal("db-now"),
  offsetMs: z.number().optional(),
});

const otpTimestampSchema = z.union([z.date(), dbNowSchema]);

export const otpIssueInputSchema = z.object({
  externalId: z.string().min(1),
  type: otpTypeSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
  durationMinutes: z.coerce.number().positive().optional(),
});

export const otpIssueOutputSchema = z.object({
  id: z.string(),
  externalId: z.string(),
  type: otpTypeSchema,
  code: z.string(),
  expiresAt: otpTimestampSchema,
  createdAt: otpTimestampSchema,
});

export const otpConfirmInputSchema = z.object({
  externalId: z.string().min(1),
  type: otpTypeSchema,
  code: z.string().min(1),
  confirmationPayload: z.record(z.string(), z.unknown()).optional(),
});

export const otpConfirmOutputSchema = z.object({
  confirmed: z.boolean(),
  confirmedAt: otpTimestampSchema.nullable(),
});

export const otpInvalidateInputSchema = z.object({
  externalId: z.string().min(1),
  type: otpTypeSchema,
});

export const otpInvalidateOutputSchema = z.object({
  invalidatedCount: z.number().int().nonnegative(),
});

export type OtpIssueInput = z.infer<typeof otpIssueInputSchema>;
export type OtpIssueOutput = z.infer<typeof otpIssueOutputSchema>;
export type OtpConfirmInput = z.infer<typeof otpConfirmInputSchema>;
export type OtpConfirmOutput = z.infer<typeof otpConfirmOutputSchema>;
export type OtpInvalidateInput = z.infer<typeof otpInvalidateInputSchema>;
export type OtpInvalidateOutput = z.infer<typeof otpInvalidateOutputSchema>;

export const otpRoutesFactory = defineRoutes(otpFragmentDefinition).create(
  ({ services, defineRoute }) => {
    return [
      defineRoute({
        method: "POST",
        path: "/otp/issue",
        inputSchema: otpIssueInputSchema,
        outputSchema: otpIssueOutputSchema,
        handler: async function ({ input }, { json }) {
          const { externalId, type, payload, durationMinutes } = await input.valid();

          const [issuedOtp] = await this.handlerTx()
            .withServiceCalls(
              () => [services.otp.issueOtp(externalId, type, durationMinutes, payload)] as const,
            )
            .execute();

          return json(issuedOtp);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/otp/confirm",
        inputSchema: otpConfirmInputSchema,
        outputSchema: otpConfirmOutputSchema,
        errorCodes: ["OTP_INVALID", "OTP_EXPIRED"] as const,
        handler: async function ({ input }, { json, error }) {
          const { externalId, type, code, confirmationPayload } = await input.valid();

          const [result] = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.otp.confirmOtp(externalId, code, type, confirmationPayload ?? null),
                ] as const,
            )
            .execute();

          if (!result.confirmed) {
            if (result.error === "OTP_EXPIRED") {
              return error({ message: "OTP has expired.", code: result.error }, 410);
            }

            return error({ message: "OTP is invalid.", code: "OTP_INVALID" }, 401);
          }

          return json({
            confirmed: true,
            confirmedAt: result.confirmedAt ?? null,
          });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/otp/invalidate",
        inputSchema: otpInvalidateInputSchema,
        outputSchema: otpInvalidateOutputSchema,
        handler: async function ({ input }, { json }) {
          const { externalId, type } = await input.valid();

          const [result] = await this.handlerTx()
            .withServiceCalls(() => [services.otp.invalidateOtps(externalId, type)] as const)
            .execute();

          return json(result);
        },
      }),
    ];
  },
);
