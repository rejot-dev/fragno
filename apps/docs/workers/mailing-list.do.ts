import { DurableObject } from "cloudflare:workers";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "@/db/mailing-list-do.migrations";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite/driver";
import type { MailingListFragment } from "@/fragno/mailing-list";
import { createMailingListServer } from "@/fragno/mailing-list";
import { mailing_list_schema } from "@/db/mailing-list-do.schema";

export class MailingList extends DurableObject<CloudflareEnv> {
  #db: DrizzleSqliteDODatabase<Record<string, unknown>>;
  #fragment: MailingListFragment;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);

    this.#db = drizzle(state.storage, {
      schema: mailing_list_schema,
    });

    state.blockConcurrencyWhile(async () => {
      await migrate(this.#db, migrations);
    });

    this.#fragment = createMailingListServer({
      env,
      db: this.#db,
      type: "live",
    });
  }

  async subscribe(email: string): Promise<{
    id: string;
    email: string;
    subscribedAt: Date;
    alreadySubscribed: boolean;
  }> {
    const fragment = this.#fragment;
    return this.#fragment.inContext(async function () {
      return this.uow(async ({ executeMutate }) => {
        const result = fragment.services.subscribe(email);
        await executeMutate();
        return result;
      });
    });
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response("Hello from MailingList");
  }
}
