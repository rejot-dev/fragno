import { createMailingListFragment } from "@fragno-dev/fragment-mailing-list";
import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import { sendEmail } from "@/resend/resend";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";

export function createAdapter(state?: DurableObjectState) {
  const dialect = new DurableObjectDialect({
    ctx: state!,
  });

  return new DrizzleAdapter({
    dialect,
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
}

export type MailingListInit =
  | {
      type: "dry-run";
    }
  | {
      type: "live";
      env: CloudflareEnv;
      state: DurableObjectState;
    };

export function createMailingListServer(init: MailingListInit) {
  return createMailingListFragment(
    {
      onSubscribe: async (email) => {
        if (init.type === "dry-run") {
          return;
        }

        const { env } = init;

        if (!env.RESEND_API_KEY) {
          throw new Error("RESEND_API_KEY is not set");
        }

        const prefix = import.meta.env.MODE === "development" ? "[DEVELOPMENT] " : "";

        const result = await sendEmail(
          {
            to: ["founders@rejot.dev"],
            subject: `${prefix}New subscriber to Fragno mailing list`,
            html: `<p>New subscriber to Fragno mailing list: ${email}</p>`,
          },
          { apiKey: env.RESEND_API_KEY },
        );

        if (result.type === "error") {
          console.error("Failed to send email", {
            error: result.error,
          });
          throw new Error(`Failed to send email: ${result.error.message}`);
        } else {
          console.log("Email sent", result.data.id);
        }
      },
    },
    { databaseAdapter: createAdapter(init.type === "live" ? init.state : undefined) },
  ).withMiddleware(async ({ ifMatchesRoute }, { error }) => {
    const getSubscribersResult = await ifMatchesRoute("GET", "/subscribers", async () => {
      return error({ message: "Not authorized", code: "NOT_AUTHORIZED" }, 401);
    });

    if (getSubscribersResult) {
      return getSubscribersResult;
    }
  });
}

export type MailingListFragment = ReturnType<typeof createMailingListServer>;

export const fragment = createMailingListServer({ type: "dry-run" });
