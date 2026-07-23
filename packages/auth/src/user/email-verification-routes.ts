import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import type { authFragmentDefinition } from "..";
import { authEmailSchema } from "./email";

export const emailVerificationRoutesFactory = defineRoutes<typeof authFragmentDefinition>().create(
  ({ services, defineRoute }) => [
    defineRoute({
      method: "POST",
      path: "/email-verification/resend",
      inputSchema: z.object({
        email: authEmailSchema,
      }),
      outputSchema: z.object({
        accepted: z.literal(true),
      }),
      errorCodes: ["invalid_input"],
      handler: async function ({ input }) {
        const { email } = await input.valid();

        await this.handlerTx()
          .withServiceCalls(() => [services.requestUserEmailVerification(email, "resend")])
          .execute();

        return Response.json({ accepted: true as const }, { status: 202 });
      },
    }),
  ],
);
