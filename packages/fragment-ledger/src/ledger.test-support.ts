import { expect } from "vitest";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import type { CreateAccountInput } from "./chart";
import { ledgerFragmentDefinition } from "./definition";
import type { createLedgerFragment } from "./fragment";
import { ledgerRoutesFactory } from "./routes";
import type { Side } from "./schema";

type Line = {
  account: string;
  side: Side;
  amount: bigint;
  functionalAmount?: bigint;
  currency?: string;
  /** A party account: makes the line an open item. */
  party?: string;
  dueDate?: string;
  dimensions?: string[];
};

type Posting = {
  /** How later steps refer to the entry. */
  name: string;
  journal: string;
  lines: Line[];
  date?: string;
  reference?: string;
  /** The source document by ID: an existing one, or a new one; by default a new one. */
  source?: { type: "new" | "existing"; id: string };
};

type LedgerRoutes = ReturnType<typeof createLedgerFragment>["callRoute"];

type Response<T> =
  | { type: "json"; data: T }
  | { type: "empty" }
  | { type: "error"; error: { code: string; message: string } }
  | { type: "jsonStream" };

export function debit(account: string, amount: bigint, details: Partial<Line> = {}): Line {
  return { account, side: "debit", amount, ...details };
}

export function credit(account: string, amount: bigint, details: Partial<Line> = {}): Line {
  return { account, side: "credit", amount, ...details };
}

/**
 * Runs a scenario against a fresh SQLite ledger, through its routes, seeded with a small EUR
 * administration. Steps refer to everything by name:
 * - fiscal year 2026 with monthly periods p1 to p12, all open
 * - journals sales, purchase, cashbook, memo
 * - accounts ar, ap, revenue, costs (requires dimension cc), bank (EUR only), usd-bank (USD only)
 * - customers alice-c and bob-c, supplier bob-s
 * - dimension cc with values cc-sales and cc-support
 */
export async function ledgerScenario(steps: (ledger: LedgerScenario) => Promise<void>) {
  const { fragments, test } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "ledger",
      instantiate(ledgerFragmentDefinition).withConfig({}).withRoutes([ledgerRoutesFactory]),
    )
    .build();
  try {
    const ledger = new LedgerScenario(fragments.ledger.callRoute);
    await ledger.seed();
    await steps(ledger);
  } finally {
    await test.cleanup();
  }
}

/** A route's refusal, with the ledger error code it answered. */
class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class LedgerScenario {
  readonly #routes: LedgerRoutes;
  readonly #ids = new Map<string, string>();
  readonly #entryJournals = new Map<string, string>();
  #periods = 0;

  constructor(routes: LedgerRoutes) {
    this.#routes = routes;
  }

  id(name: string): string {
    const id = this.#ids.get(name);
    if (!id) {
      throw new Error(`The scenario has nothing named ${name}.`);
    }
    return id;
  }

  async refuses(step: () => Promise<unknown>, code: string): Promise<void> {
    await expect(step()).rejects.toMatchObject({ code });
  }

  async seed(): Promise<void> {
    accepted(
      await this.#routes("POST", "/ledger", {
        body: { name: "Acme BV", functionalCurrency: { code: "EUR", minorUnitDigits: 2 } },
      }),
    );
    accepted(
      await this.#routes("POST", "/currencies", { body: { code: "USD", minorUnitDigits: 2 } }),
    );
    await this.openFiscalYear({
      name: "2026",
      startDate: "2026-01-01",
      periodEndDates: monthEnds(2026),
    });

    for (const [name, code] of [
      ["sales", "VK"],
      ["purchase", "IK"],
      ["cashbook", "BNK"],
      ["memo", "MEM"],
    ]) {
      this.#name(
        name,
        accepted(await this.#routes("POST", "/journals", { body: { code, name } })).id,
      );
    }

    const dimension = accepted(
      await this.#routes("POST", "/dimensions", { body: { code: "CC", name: "Cost centre" } }),
    );
    this.#name("cc", dimension.id);
    for (const [name, code] of [
      ["cc-sales", "S"],
      ["cc-support", "SU"],
    ]) {
      this.#name(
        name,
        accepted(
          await this.#routes("POST", "/dimensions/:dimensionId/values", {
            pathParams: { dimensionId: dimension.id },
            body: { code, name },
          }),
        ).id,
      );
    }

    const ordinary = { normalSide: "debit", currency: null, dimensionRules: {} } as const;
    await this.createAccount("ar", {
      ...ordinary,
      code: "1300",
      classification: { type: "asset", role: "receivable" },
    });
    await this.createAccount("ap", {
      ...ordinary,
      code: "1600",
      classification: { type: "liability", role: "payable" },
      normalSide: "credit",
    });
    await this.createAccount("revenue", {
      ...ordinary,
      code: "8000",
      classification: { type: "revenue", role: "ordinary" },
      normalSide: "credit",
    });
    await this.createAccount("costs", {
      ...ordinary,
      code: "4000",
      classification: { type: "expense", role: "ordinary" },
      dimensionRules: { [this.id("cc")]: "required" },
    });
    await this.createAccount("bank", {
      ...ordinary,
      code: "1100",
      classification: { type: "asset", role: "ordinary" },
      currency: "EUR",
    });
    await this.createAccount("usd-bank", {
      ...ordinary,
      code: "1110",
      classification: { type: "asset", role: "ordinary" },
      currency: "USD",
    });

    await this.createPartyAccount("alice-c", {
      party: "alice",
      role: "customer",
      code: "C1",
      control: "ar",
    });
    await this.createPartyAccount("bob-c", {
      party: "bob",
      role: "customer",
      code: "C2",
      control: "ar",
    });
    await this.createPartyAccount("bob-s", {
      party: "bob",
      role: "supplier",
      code: "S1",
      control: "ap",
    });
  }

  async openFiscalYear(input: {
    name: string;
    startDate: string;
    periodEndDates: string[];
  }): Promise<void> {
    const year = accepted(await this.#routes("POST", "/fiscal-years", { body: input }));
    // Periods are numbered across years: 2027's January is p13.
    for (const periodId of year.periodIds) {
      this.#periods += 1;
      this.#name(`p${this.#periods}`, periodId);
    }
  }

  async createAccount(name: string, input: Omit<CreateAccountInput, "name">): Promise<void> {
    const account = accepted(await this.#routes("POST", "/accounts", { body: { ...input, name } }));
    this.#name(name, account.id);
  }

  async deactivateAccount(name: string): Promise<void> {
    const account = (await this.accounts()).find((row) => row.id === this.id(name))!;
    accepted(
      await this.#routes("PUT", "/accounts/:accountId", {
        pathParams: { accountId: account.id },
        body: { name: account.name, active: false, dimensionRules: account.dimensionRules },
      }),
    );
  }

  /** Gives the party named `input.party` an account; a party the scenario has no name for is new. */
  async createPartyAccount(
    name: string,
    input: { party: string; role: "customer" | "supplier"; code: string; control: string },
  ): Promise<void> {
    const partyId = this.#ids.get(input.party);
    const partyAccount = accepted(
      await this.#routes("POST", "/party-accounts", {
        body: {
          party: partyId === undefined ? { name: input.party } : { id: partyId },
          role: input.role,
          code: input.code,
          controlAccountId: this.id(input.control),
        },
      }),
    );
    if (partyId === undefined) {
      this.#name(input.party, partyAccount.partyId);
    }
    this.#name(name, partyAccount.id);
  }

  async parties() {
    return accepted(await this.#routes("GET", "/parties"));
  }

  async post(posting: Posting) {
    const date = posting.date ?? "2026-01-10";
    const entry = accepted(
      await this.#routes("POST", "/entries", {
        body: {
          journalId: this.id(posting.journal),
          postingDate: date,
          description: posting.name,
          reference: posting.reference ?? null,
          postedBy: "scenario-user",
          source:
            posting.source?.type === "existing"
              ? { type: "existing", id: posting.source.id }
              : {
                  type: "new",
                  id: posting.source?.id ?? crypto.randomUUID(),
                  kind: "manual_journal",
                  documentDate: date,
                  description: posting.name,
                },
          lines: posting.lines.map((line) => ({
            accountId: this.id(line.account),
            side: line.side,
            currency: line.currency ?? "EUR",
            amountMinor: String(line.amount),
            functionalAmountMinor: String(line.functionalAmount ?? line.amount),
            description: "",
            dimensionValueIds: (line.dimensions ?? []).map((dimension) => this.id(dimension)),
            openItem: line.party
              ? { partyAccountId: this.id(line.party), dueDate: line.dueDate ?? "2026-02-10" }
              : null,
          })),
        },
      }),
    );
    this.#name(posting.name, entry.id);
    this.#entryJournals.set(posting.name, posting.journal);
    return entry;
  }

  async reverse(name: string, entry: string, date = "2026-01-20") {
    const reversal = accepted(
      await this.#routes("POST", "/entries/:entryId/reversal", {
        pathParams: { entryId: this.id(entry) },
        body: { postingDate: date, description: `reverses ${entry}`, postedBy: "scenario-user" },
      }),
    );
    this.#name(name, reversal.id);
    this.#entryJournals.set(name, this.#entryJournals.get(entry)!);
    return reversal;
  }

  async allocate(input: {
    name: string;
    debit: readonly [entry: string, line: number];
    credit: readonly [entry: string, line: number];
    /** Null settles all both items have outstanding. */
    amount: bigint | null;
  }): Promise<bigint> {
    const allocation = accepted(
      await this.#routes("POST", "/allocations", {
        body: {
          debitItemId: await this.openItemId(...input.debit),
          creditItemId: await this.openItemId(...input.credit),
          amountMinor: input.amount === null ? null : String(input.amount),
          allocatedBy: "scenario-user",
        },
      }),
    );
    this.#name(input.name, allocation.id);
    return BigInt(allocation.amountMinor);
  }

  async reverseAllocation(allocation: string): Promise<void> {
    accepted(
      await this.#routes("POST", "/allocations/:allocationId/reversal", {
        pathParams: { allocationId: this.id(allocation) },
        body: { reversedBy: "scenario-user" },
      }),
    );
  }

  async transitionPeriod(period: string, transition: "close" | "reopen" | "lock"): Promise<void> {
    const pathParams = { periodId: this.id(period) };
    accepted(
      transition === "close"
        ? await this.#routes("POST", "/periods/:periodId/close", { pathParams })
        : transition === "reopen"
          ? await this.#routes("POST", "/periods/:periodId/reopen", { pathParams })
          : await this.#routes("POST", "/periods/:periodId/lock", { pathParams }),
    );
  }

  async entry(journal: string, entryNumber: number) {
    return accepted(
      await this.#routes("GET", "/journals/:journalId/entries/:entryNumber", {
        pathParams: { journalId: this.id(journal), entryNumber: String(entryNumber) },
      }),
    );
  }

  async entries(journal: string) {
    return accepted(
      await this.#routes("GET", "/journals/:journalId/entries", {
        pathParams: { journalId: this.id(journal) },
      }),
    ).items;
  }

  async accounts() {
    return accepted(await this.#routes("GET", "/accounts"));
  }

  async fiscalYears() {
    return accepted(await this.#routes("GET", "/fiscal-years"));
  }

  async openItems(partyAccount: string) {
    return accepted(
      await this.#routes("GET", "/party-accounts/:partyAccountId/open-items", {
        pathParams: { partyAccountId: this.id(partyAccount) },
      }),
    );
  }

  async outstanding(entry: string, line: number): Promise<bigint> {
    const itemId = await this.openItemId(entry, line);
    for (const partyAccount of ["alice-c", "bob-c", "bob-s"]) {
      const item = (await this.openItems(partyAccount)).find((row) => row.id === itemId);
      if (item) {
        return BigInt(item.outstandingMinor);
      }
    }
    throw new Error(`Line ${line} of ${entry} is not an open item.`);
  }

  /** Each account's code with its debit and credit totals, through a period. */
  async trialBalance(period: string) {
    const rows = accepted(
      await this.#routes("GET", "/periods/:periodId/trial-balance", {
        pathParams: { periodId: this.id(period) },
      }),
    );
    return Object.fromEntries(
      rows.map((row) => [row.code, [BigInt(row.debitMinor), BigInt(row.creditMinor)]]),
    );
  }

  async openItemId(entry: string, lineNumber: number): Promise<string> {
    const entries = await this.entries(this.#entryJournals.get(entry)!);
    const line = entries
      .find((row) => row.id === this.id(entry))
      ?.lines.find((row) => row.number === lineNumber);
    if (!line?.openItem) {
      throw new Error(`Line ${lineNumber} of ${entry} is not an open item.`);
    }
    return line.openItem.id;
  }

  #name(name: string, id: string): void {
    if (this.#ids.has(name)) {
      throw new Error(`The scenario already has something named ${name}.`);
    }
    this.#ids.set(name, id);
  }
}

function accepted<T>(response: Response<T>): T {
  if (response.type === "error") {
    throw new Refusal(response.error.code, response.error.message);
  }
  if (response.type !== "json") {
    return undefined as T;
  }
  return response.data;
}

function monthEnds(year: number): string[] {
  return Array.from({ length: 12 }, (_, month) =>
    new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10),
  );
}
