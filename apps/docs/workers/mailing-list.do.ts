import { DurableObject } from "cloudflare:workers";
import type { MailingListFragment } from "@/fragno/mailing-list";
import { createMailingListServer } from "@/fragno/mailing-list";
import { migrate } from "@fragno-dev/db";

export class MailingList extends DurableObject<CloudflareEnv> {
  #fragment: MailingListFragment;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);

    this.#fragment = createMailingListServer({
      env,
      state: state,
      type: "live",
    });

    state.blockConcurrencyWhile(async () => {
      try {
        await migrate(this.#fragment);
      } catch (error) {
        console.log("Migration failed", { error });
      }
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
