import { createMailingListFragment } from "@fragno-dev/fragment-mailing-list";
import { DrizzleAdapter } from "@fragno-dev/db/adapters/drizzle";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite/driver";
import { sendEmail } from "@/resend/resend";

export function createAdapter(db?: DrizzleSqliteDODatabase<Record<string, unknown>>) {
  return new DrizzleAdapter({
    db: db ?? {},
    provider: "sqlite",
  });
}

export type MailingListInit =
  | {
      type: "dry-run";
    }
  | {
      type: "live";
      env: CloudflareEnv;
      db: DrizzleSqliteDODatabase<Record<string, unknown>>;
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
          console.error("RESEND_API_KEY is not set");
          return;
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
          console.error("Failed to send email", result.error);
        } else {
          console.log("Email sent", result.data.id);
        }
      },
    },
    { databaseAdapter: createAdapter(init.type === "live" ? init.db : undefined) },
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
