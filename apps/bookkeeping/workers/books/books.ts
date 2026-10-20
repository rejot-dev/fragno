import { DurableObject } from "cloudflare:workers";

import { applyMigrations } from "../migrations";
import { FUNCTIONAL_CURRENCIES, type FunctionalCurrency } from "./currencies";
import { bookkeepingSchema } from "./schema";

/** What the books say about their administration. */
export type BooksSummary = { name: string; functionalCurrency: FunctionalCurrency };

/** One administration's books: its own SQLite database, named by the administration's ID. */
export class Books extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx, [bookkeepingSchema]);
    });
  }

  /**
   * Opens the books of a new administration. Opening them again keeps what the first opening
   * set, so creating an administration can be repeated after a failure.
   */
  open(input: { name: string; functionalCurrency: FunctionalCurrency }): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO currency (code, minor_unit_digits) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        input.functionalCurrency,
        FUNCTIONAL_CURRENCIES[input.functionalCurrency],
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO administration (singleton, name, functional_currency) VALUES (1, ?, ?)
         ON CONFLICT DO NOTHING`,
        input.name,
        input.functionalCurrency,
      );
    });
  }

  summarize(): BooksSummary {
    const [summary] = this.ctx.storage.sql
      .exec<BooksSummary>(
        `SELECT name, functional_currency AS functionalCurrency FROM administration`,
      )
      .toArray();
    if (!summary) {
      throw new Error("These books were never opened.");
    }
    return summary;
  }
}
