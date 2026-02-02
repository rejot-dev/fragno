import { createFormsFragment } from "@fragno-dev/forms";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";

import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { STATIC_FORMS } from "./static-forms";
import { validateTurnstileToken } from "@/cloudflare/turnstile";
import { sendEmail } from "@/resend/resend";

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new SqlAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

export type FormsInit =
  | {
      type: "dry-run";
    }
  | {
      type: "live";
      env: CloudflareEnv;
      state: DurableObjectState;
    };

export function createFormsServer(init: FormsInit) {
  const turnstileSecretKey = init.type === "live" ? init.env.TURNSTILE_SECRET_KEY : undefined;

  return createFormsFragment(
    {
      onResponseSubmitted: async (response) => {
        if (init.type === "dry-run") {
          return;
        }

        const { env } = init;

        if (!env.RESEND_API_KEY) {
          console.warn("RESEND_API_KEY is not set");
          return;
        }

        const prefix = import.meta.env.MODE === "development" ? "[DEVELOPMENT] " : "";

        const result = await sendEmail(
          {
            to: ["founders@rejot.dev"],
            subject: `${prefix}New submission for form ${response.formId}`,
            html: `<pre> ${JSON.stringify(response.data)}</pre>`,
          },
          { apiKey: env.RESEND_API_KEY },
        );

        if (result.type === "error") {
          console.warn("Failed to send email", {
            error: result.error,
          });
        } else {
          console.log("Email sent", result.data.id);
        }
      },
      staticForms: STATIC_FORMS,
    },
    { databaseAdapter: createAdapter(init.type === "live" ? init.state : undefined) },
  ).withMiddleware(async ({ path, ifMatchesRoute }, { error }) => {
    if (path.startsWith("/admin")) {
      return error({ message: "Not authorized", code: "NOT_AUTHORIZED" }, 401);
    }

    const submitResult = await ifMatchesRoute("POST", "/:slug/submit", async ({ input }) => {
      const { securityToken } = await input.valid();

      if (!securityToken) {
        return error({ message: "Missing securityToken in body", code: "TURNSTILE_REQUIRED" }, 400);
      }

      const turnstileResult = await validateTurnstileToken(turnstileSecretKey, securityToken);
      if (!turnstileResult.success) {
        return error({ message: "Turnstile validation failed", code: "TURNSTILE_FAILED" }, 403);
      }
    });

    if (submitResult) {
      return submitResult;
    }

    return undefined;
  });
}

export type FormsFragment = ReturnType<typeof createFormsServer>;

export const fragment = createFormsServer({ type: "dry-run" });
