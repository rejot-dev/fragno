import { assert, expect, test } from "vitest";

import {
  runBookkeepingScenario,
  type BookkeepingScenario,
  type ScenarioBrowser,
} from "../../scenario/bookkeeping-scenario";
import type { BooksOutletContext } from "./layout";

const BOOKS = "/w/analytical-engines/a/analytical-engines";

type Books = BooksOutletContext["books"];

/** Ada's practice keeps the books of Analytical Engines, which she has just opened. */
async function openBooks(scenario: BookkeepingScenario) {
  const practice = await scenario.practice();
  await scenario.openAdministration(practice.ada, practice.clientPath, "Analytical Engines");
  return practice;
}

/** Bookkeeping's member Charles, who keeps the books but does not set them up. */
async function charlesJoins(scenario: BookkeepingScenario, ada: ScenarioBrowser) {
  const path = await scenario.invite(
    ada,
    "/w/analytical-engines",
    "charles@example.test",
    "member",
  );
  const { browser } = await scenario.acceptInvitation("charles@example.test", "Charles Babbage", {
    path,
  });
  return browser;
}

async function readBooks(browser: ScenarioBrowser): Promise<Books> {
  const page = await browser.navigate(`${BOOKS}/settings`);
  return (page.loaderData["books/layout"] as { books: Books }).books;
}

function find<T extends { code: string; id: string }>(rows: T[], code: string): T {
  const row = rows.find((candidate) => candidate.code === code);
  assert(row, `No ${code}.`);
  return row;
}

type EntryLine = {
  account: string;
  debit?: string;
  credit?: string;
  /** A customer's or supplier's code. */
  party?: string;
  currency?: string;
  functionalAmount?: string;
  /** Dimension code to value code. */
  dimensions?: Record<string, string>;
};

/** The new-entry form as a person fills it in, naming accounts, journals, and parties by code. */
function entryForm(
  books: Books,
  entry: {
    journal: string;
    date: string;
    description: string;
    reference?: string;
    lines: EntryLine[];
  },
): Record<string, string> {
  const form: Record<string, string> = {
    journalId: find(books.journals, entry.journal).id,
    postingDate: entry.date,
    reference: entry.reference ?? "",
    description: entry.description,
  };
  entry.lines.forEach((line, row) => {
    const field = (name: string, value: string | undefined) => {
      form[`lines.${row}.${name}`] = value ?? "";
    };
    field("accountId", find(books.accounts, line.account).id);
    field("description", "");
    field("debit", line.debit);
    field("credit", line.credit);
    field("currency", line.currency ?? books.functionalCurrency);
    field("functionalAmount", line.functionalAmount);
    const partyAccounts = books.parties.flatMap((party) => party.accounts);
    field("partyAccountId", line.party && find(partyAccounts, line.party).id);
    for (const [dimensionCode, valueCode] of Object.entries(line.dimensions ?? {})) {
      const dimension = find(books.dimensions, dimensionCode);
      field(`dimension.${dimension.id}`, find(dimension.values, valueCode).id);
    }
  });
  return form;
}

type Entries = { items: { entryNumber: number; description: string }[] };

async function journal(browser: ScenarioBrowser, books: Books, code: string) {
  const page = await browser.navigate(`${BOOKS}?journal=${find(books.journals, code).id}`);
  return (page.loaderData["books/journal"] as { entries: Entries }).entries.items;
}

async function trialBalance(browser: ScenarioBrowser, periodId: string) {
  const page = await browser.navigate(`${BOOKS}/trial-balance?period=${periodId}`);
  const { rows } = page.loaderData["books/trial-balance"] as {
    rows: { code: string; debitMinor: bigint; creditMinor: bigint }[];
  };
  return Object.fromEntries(rows.map((row) => [row.code, [row.debitMinor, row.creditMinor]]));
}

type OpenItem = { id: string; side: string; outstandingMinor: bigint };

async function openItems(browser: ScenarioBrowser, partyAccountId: string) {
  const page = await browser.navigate(`${BOOKS}/parties/${partyAccountId}`);
  return (
    page.loaderData["books/party-account"] as {
      items: (OpenItem & { allocations: { id: string; reversed: boolean }[] })[];
    }
  ).items;
}

test("new books open ready to post: this year's periods, journals, and a chart of accounts", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    const books = await readBooks(ada);
    const year = String(new Date().getUTCFullYear());

    expect(books).toMatchObject({
      name: "Analytical Engines",
      functionalCurrency: "EUR",
      currencies: [{ code: "EUR", minorUnitDigits: 2 }],
      fiscalYears: [{ name: year, startDate: `${year}-01-01`, endDate: `${year}-12-31` }],
      journals: [{ code: "BNK" }, { code: "GEN" }, { code: "PUR" }, { code: "SAL" }],
      dimensions: [],
      parties: [],
    });
    expect(books.fiscalYears[0].periods.map((period) => period.status)).toEqual(
      Array.from({ length: 12 }, () => "open"),
    );
    expect(books.accounts.map((account) => `${account.code} ${account.role}`)).toEqual([
      "0500 ordinary",
      "1000 ordinary",
      "1300 receivable",
      "1500 ordinary",
      "1600 payable",
      "1700 ordinary",
      "4000 ordinary",
      "7000 ordinary",
      "8000 ordinary",
    ]);
    expect(await journal(ada, books, "GEN")).toEqual([]);
  });
});

test("a sale and its payment are posted, settled against each other, and add up in the trial balance", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    const year = new Date().getUTCFullYear();
    expect(
      await ada.submit(`${BOOKS}/parties`, {
        intent: "add-party-account",
        partyId: "new",
        name: "Lady Byron",
        role: "customer",
        code: "C001",
        controlAccountId: "usual",
      }),
    ).toMatchObject({ actionData: { intent: "add-party-account", error: null } });
    // Codes are unique per role, and checked before the party is created.
    expect(
      await ada.submit(`${BOOKS}/parties`, {
        intent: "add-party-account",
        partyId: "new",
        name: "Someone Else",
        role: "customer",
        code: "C001",
        controlAccountId: "usual",
      }),
    ).toMatchObject({ actionData: { error: "A customer with code C001 already exists." } });
    let books = await readBooks(ada);
    expect(books.parties).toMatchObject([
      { name: "Lady Byron", accounts: [{ role: "customer", code: "C001" }] },
    ]);
    const byron = books.parties[0].accounts[0].id;

    const sale = {
      journal: "SAL",
      date: `${year}-03-10`,
      description: "Invoice 1",
      reference: "INV-1",
      lines: [
        { account: "1300", debit: "121", party: "C001" },
        { account: "8000", credit: "100.00" },
        { account: "1700", credit: "21,00" },
      ],
    };
    expect(await ada.submit(`${BOOKS}/entries/new`, entryForm(books, sale))).toMatchObject({
      path: `${BOOKS}?journal=${find(books.journals, "SAL").id}`,
    });

    expect(await ada.submit(`${BOOKS}/entries/new`, entryForm(books, sale))).toMatchObject({
      actionData: { error: "Entry SAL 1 already has reference INV-1." },
    });
    const unbalanced = { ...sale, reference: "", lines: [sale.lines[0], sale.lines[1]] };
    expect(await ada.submit(`${BOOKS}/entries/new`, entryForm(books, unbalanced))).toMatchObject({
      actionData: { error: "Debits (12100) and credits (10000) must balance." },
    });
    const withoutParty = {
      ...sale,
      reference: "",
      lines: [{ account: "1300", debit: "121" }, ...sale.lines.slice(1)],
    };
    expect(await ada.submit(`${BOOKS}/entries/new`, entryForm(books, withoutParty))).toMatchObject({
      actionData: { error: "Lines on control account 1300 need a party." },
    });
    expect(
      await ada.submit(`${BOOKS}/entries/new`, {
        ...entryForm(books, sale),
        "lines.1.credit": "100.001",
      }),
    ).toMatchObject({
      actionData: {
        error: "Line 2: enter the amount as a number with at most 2 decimals, like 1234.50.",
      },
    });

    await ada.submit(
      `${BOOKS}/entries/new`,
      entryForm(books, {
        journal: "BNK",
        date: `${year}-03-20`,
        description: "Payment invoice 1",
        lines: [
          { account: "1000", debit: "121.00" },
          { account: "1300", credit: "121.00", party: "C001" },
        ],
      }),
    );
    books = await readBooks(ada);
    expect(await journal(ada, books, "SAL")).toMatchObject([
      { entryNumber: 1, description: "Invoice 1", reference: "INV-1", postedBy: "Ada Lovelace" },
    ]);

    // Settling without an amount settles all both items have outstanding; undoing restores it.
    const [invoice, payment] = await openItems(ada, byron);
    expect([invoice, payment]).toMatchObject([
      { side: "debit", outstandingMinor: 12100n },
      { side: "credit", outstandingMinor: 12100n },
    ]);
    expect(
      await ada.submit(`${BOOKS}/parties/${byron}`, {
        intent: "allocate",
        debitItemId: invoice.id,
        creditItemId: payment.id,
        amount: "121.01",
      }),
    ).toMatchObject({
      actionData: { error: "The allocation exceeds an item's outstanding amount." },
    });
    await ada.submit(`${BOOKS}/parties/${byron}`, {
      intent: "allocate",
      debitItemId: invoice.id,
      creditItemId: payment.id,
      amount: "",
    });
    let settled = await openItems(ada, byron);
    expect(settled.map((item) => item.outstandingMinor)).toEqual([0n, 0n]);
    await ada.submit(`${BOOKS}/parties/${byron}`, {
      intent: "undo-allocation",
      allocationId: settled[0].allocations[0].id,
    });
    settled = await openItems(ada, byron);
    expect(settled).toMatchObject([
      { outstandingMinor: 12100n, allocations: [{ reversed: true }] },
      { outstandingMinor: 12100n, allocations: [{ reversed: true }] },
    ]);

    const march = books.fiscalYears[0].periods[2].id;
    expect(await trialBalance(ada, march)).toEqual({
      "1000": [12100n, 0n],
      "1300": [12100n, 12100n],
      "1700": [0n, 2100n],
      "8000": [0n, 10000n],
    });
    expect(await trialBalance(ada, books.fiscalYears[0].periods[1].id)).toEqual({});

    // A reversal undoes the sale in its journal, from the sale's page; an entry is reversed once.
    const salePage = `${BOOKS}/entries/SAL/1`;
    const reverse = { intent: "reverse", postingDate: `${year}-03-31` };
    expect(await ada.submit(salePage, { ...reverse, postingDate: "" })).toMatchObject({
      actionData: { intent: "reverse", error: "Choose the date to reverse the entry on." },
    });
    expect(await ada.submit(salePage, reverse)).toMatchObject({ path: `${BOOKS}/entries/SAL/2` });
    expect(await ada.submit(salePage, reverse)).toMatchObject({
      actionData: { intent: "reverse", error: "The entry is already reversed." },
    });
    expect(await journal(ada, books, "SAL")).toMatchObject([
      { entryNumber: 2, reverses: { entryNumber: 1 } },
      { entryNumber: 1, reversedBy: { entryNumber: 2 } },
    ]);
    expect(await trialBalance(ada, march)).toMatchObject({ "8000": [10000n, 10000n] });
    // The reversal settles the invoice, so only Byron's payment is left open: owed back to him.
    expect((await openItems(ada, byron)).map((item) => [item.side, item.outstandingMinor])).toEqual(
      [
        ["debit", 0n],
        ["credit", 0n],
        ["credit", 12100n],
      ],
    );
  });
});

test("owners and admins set the books up; every member keeps them", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    const charles = await charlesJoins(scenario, ada);
    const year = new Date().getUTCFullYear();
    let books = await readBooks(ada);
    const [january, february] = books.fiscalYears[0].periods;

    for (const [path, form] of [
      [`${BOOKS}/settings`, { intent: "create-journal", code: "MEM", name: "Memorial" }],
      [
        `${BOOKS}/settings`,
        { intent: "transition-period", periodId: january.id, transition: "close" },
      ],
      [
        `${BOOKS}/accounts`,
        {
          intent: "create-account",
          code: "4100",
          name: "Rent",
          kind: "expense",
          normalSide: "usual",
          currency: "any",
        },
      ],
    ] as const) {
      expect(await charles.submit(path, form)).toMatchObject({ status: 403 });
    }

    // A cost centre dimension, required on a new rent account.
    await ada.submit(`${BOOKS}/settings`, {
      intent: "create-dimension",
      code: "CC",
      name: "Cost centre",
    });
    books = await readBooks(ada);
    const costCentre = find(books.dimensions, "CC");
    // Each dimension has its own form for values, which its refusals show under.
    const dimensionValue = {
      intent: "create-dimension-value",
      resultIntent: `create-dimension-value-${costCentre.id}`,
      dimensionId: costCentre.id,
    };
    expect(
      await ada.submit(`${BOOKS}/settings`, {
        ...dimensionValue,
        code: "LABORATORY-AND-WORKSHOP",
        name: "Laboratory",
      }),
    ).toMatchObject({
      actionData: {
        intent: `create-dimension-value-${costCentre.id}`,
        error: "Use at most 20 characters.",
      },
    });
    for (const [code, name] of [
      ["LAB", "Laboratory"],
      ["OFF", "Office"],
    ]) {
      await ada.submit(`${BOOKS}/settings`, { ...dimensionValue, code, name });
    }
    expect(
      await ada.submit(`${BOOKS}/accounts`, {
        intent: "create-account",
        code: "4100",
        name: "Rent",
        kind: "expense",
        normalSide: "usual",
        currency: "any",
        [`dimension.${costCentre.id}`]: "required",
      }),
    ).toMatchObject({ actionData: { error: null } });
    expect(
      await ada.submit(`${BOOKS}/accounts`, {
        intent: "create-account",
        code: "4100",
        name: "Rent again",
        kind: "expense",
        normalSide: "usual",
        currency: "any",
      }),
    ).toMatchObject({ actionData: { error: "Account 4100 already exists." } });
    await ada.submit(`${BOOKS}/settings`, {
      intent: "add-currency",
      code: "usd",
      minorUnitDigits: "2",
    });
    books = await readBooks(ada);
    expect(find(books.accounts, "4100")).toMatchObject({
      type: "expense",
      normalSide: "debit",
      dimensionRules: { [costCentre.id]: "required" },
    });
    expect(books.currencies.map((currency) => currency.code)).toEqual(["EUR", "USD"]);

    const rent = (date: string, lines: EntryLine[]) =>
      entryForm(books, { journal: "PUR", date, description: "Rent", lines });
    const rentLines: EntryLine[] = [
      { account: "4100", debit: "500", dimensions: { CC: "LAB" } },
      { account: "1000", credit: "550", currency: "USD", functionalAmount: "500" },
    ];
    expect(
      await charles.submit(
        `${BOOKS}/entries/new`,
        rent(`${year}-02-01`, [{ ...rentLines[0], dimensions: {} }, rentLines[1]]),
      ),
    ).toMatchObject({
      actionData: { error: `Dimension ${costCentre.id} is required on account 4100.` },
    });
    await charles.submit(`${BOOKS}/entries/new`, rent(`${year}-02-01`, rentLines));
    expect(await journal(charles, books, "PUR")).toMatchObject([
      {
        entryNumber: 1,
        postedBy: "Charles Babbage",
        lines: [
          {
            amountMinor: 50000n,
            dimensionValueIds: [find(find(books.dimensions, "CC").values, "LAB").id],
          },
          { currency: "USD", amountMinor: 55000n, functionalAmountMinor: 50000n },
        ],
      },
    ]);

    // Closed periods take no postings until they reopen; locked ones never do.
    await ada.submit(`${BOOKS}/settings`, {
      intent: "transition-period",
      periodId: february.id,
      transition: "close",
    });
    expect(
      await charles.submit(`${BOOKS}/entries/new`, rent(`${year}-02-02`, rentLines)),
    ).toMatchObject({
      actionData: { error: `No open period contains ${year}-02-02.` },
    });
    await ada.submit(`${BOOKS}/settings`, {
      intent: "transition-period",
      periodId: february.id,
      transition: "lock",
    });
    expect(
      await ada.submit(`${BOOKS}/settings`, {
        intent: "transition-period",
        periodId: february.id,
        transition: "reopen",
      }),
    ).toMatchObject({
      actionData: {
        intent: "transition-period",
        error: "Only closed periods can reopen; this period is locked.",
      },
    });

    // An inactive account takes no new postings.
    const rentAccount = find(books.accounts, "4100");
    await ada.submit(`${BOOKS}/accounts/${rentAccount.id}`, {
      intent: "update-account",
      name: "Rent and service charges",
      status: "inactive",
      [`dimension.${costCentre.id}`]: "required",
    });
    expect(
      await charles.submit(`${BOOKS}/entries/new`, rent(`${year}-03-01`, rentLines)),
    ).toMatchObject({
      actionData: { error: "Account 4100 is inactive." },
    });

    // The next fiscal year starts the day after this one ends.
    await ada.submit(`${BOOKS}/settings`, {
      intent: "open-fiscal-year",
      name: String(year + 1),
      startDate: "",
      periodLength: "quarter",
    });
    books = await readBooks(ada);
    expect(books.fiscalYears[1]).toMatchObject({
      name: String(year + 1),
      startDate: `${year + 1}-01-01`,
      endDate: `${year + 1}-12-31`,
      periods: [
        { endDate: `${year + 1}-03-31` },
        { endDate: `${year + 1}-06-30` },
        { endDate: `${year + 1}-09-30` },
        { endDate: `${year + 1}-12-31` },
      ],
    });
    expect(find(books.accounts, "4100")).toMatchObject({
      name: "Rent and service charges",
      active: false,
    });
  });
});
