import { assert, expect, test } from "vitest";

import {
  runBookkeepingScenario,
  type BookkeepingScenario,
  type ScenarioBrowser,
} from "../../scenario/bookkeeping-scenario";
import { INVOICE } from "../../scenario/fixtures/invoice";
import {
  ACCOUNT_IBAN,
  closingCents,
  marchStatement,
  nextStatement,
  renderCamt053,
  type FixtureStatement,
} from "../../scenario/fixtures/statement";
import type { BankAccountView, TransactionView } from "../../workers/books/banking/banking";
import type { BooksOutletContext } from "../books/layout";

const BOOKS = "/w/analytical-engines/a/analytical-engines";
const YEAR = new Date().getUTCFullYear();

type Books = BooksOutletContext["books"];
type Listed = Pick<TransactionView, "id" | "bookingDate" | "amountMinor" | "detail" | "state">;

/** Ada's practice keeps the books of Analytical Engines, which she has just opened. */
async function openBooks(scenario: BookkeepingScenario) {
  const practice = await scenario.practice();
  await scenario.openAdministration(practice.ada, practice.clientPath, "Analytical Engines");
  return practice;
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

/** Ada adds Analytical Engines' current account, booked to account 1000 in the bank journal. */
async function addCurrentAccount(ada: ScenarioBrowser): Promise<string> {
  const books = await readBooks(ada);
  const added = await ada.submit(`${BOOKS}/bank`, {
    intent: "add-bank-account",
    name: "Current account",
    iban: "NL20 INGB 0001 2345 67",
    code: "1000",
    journalId: find(books.journals, "BNK").id,
  });
  const id = /\/bank\/([^/]+)$/u.exec(added.path)?.[1];
  assert(id, `The bank account did not open: ${JSON.stringify(added)}`);
  return id;
}

async function importStatements(
  browser: ScenarioBrowser,
  bankAccountId: string,
  file: string | FixtureStatement[],
) {
  const page = await browser.upload(
    `${BOOKS}/bank/${bankAccountId}`,
    { intent: "import" },
    {
      name: "statement.xml",
      type: "application/xml",
      bytes: new TextEncoder().encode(typeof file === "string" ? file : renderCamt053(file)),
    },
  );
  return page.actionData;
}

async function bankAccount(browser: ScenarioBrowser, bankAccountId: string, show = "to-book") {
  const page = await browser.navigate(`${BOOKS}/bank/${bankAccountId}?show=${show}`);
  return page.loaderData["banking/account"] as {
    bankAccount: BankAccountView;
    transactions: { items: Listed[] };
  };
}

/** The account's transactions to book, oldest first, by what they were. */
async function toBook(browser: ScenarioBrowser, bankAccountId: string) {
  const { transactions } = await bankAccount(browser, bankAccountId);
  return [...transactions.items].reverse();
}

async function transactionPage(browser: ScenarioBrowser, transactionId: string, party = "") {
  const page = await browser.navigate(
    `${BOOKS}/bank/transactions/${transactionId}${party === "" ? "" : `?party=${party}`}`,
  );
  return page.loaderData["banking/transaction"] as {
    transaction: TransactionView;
    suggested: string[];
    partyAccountId: string | null;
    items: { id: string; entry: { reference: string | null }; outstandingMinor: bigint }[];
    preselected: Record<string, bigint>;
  };
}

async function addParty(
  ada: ScenarioBrowser,
  party: { name: string; role: "customer" | "supplier"; code: string },
) {
  const added = await ada.submit(`${BOOKS}/parties`, {
    intent: "add-party-account",
    partyId: "new",
    ...party,
    controlAccountId: "usual",
  });
  expect(added).toMatchObject({ actionData: { error: null } });
}

/** Posts an entry through the new-entry form, naming accounts and parties by code. */
async function post(
  ada: ScenarioBrowser,
  books: Books,
  entry: {
    journal: string;
    date: string;
    description: string;
    reference: string;
    lines: { account: string; debit?: string; credit?: string; party?: string }[];
  },
  transactionId?: string,
) {
  const form: Record<string, string> = {
    journalId: find(books.journals, entry.journal).id,
    postingDate: entry.date,
    reference: entry.reference,
    description: entry.description,
    ...(transactionId === undefined ? {} : { transactionId }),
  };
  const partyAccounts = books.parties.flatMap((party) => party.accounts);
  entry.lines.forEach((line, row) => {
    form[`lines.${row}.accountId`] = find(books.accounts, line.account).id;
    form[`lines.${row}.debit`] = line.debit ?? "";
    form[`lines.${row}.credit`] = line.credit ?? "";
    form[`lines.${row}.partyAccountId`] = line.party ? find(partyAccounts, line.party).id : "";
  });
  return await ada.submit(`${BOOKS}/entries/new`, form);
}

async function trialBalance(browser: ScenarioBrowser, periodId: string) {
  const page = await browser.navigate(`${BOOKS}/trial-balance?period=${periodId}`);
  const { rows } = page.loaderData["books/trial-balance"] as {
    rows: { code: string; debitMinor: bigint; creditMinor: bigint }[];
  };
  return Object.fromEntries(rows.map((row) => [row.code, [row.debitMinor, row.creditMinor]]));
}

/** Bookkeeping's member Charles, who keeps the books but does not set them up. */
async function charlesJoins(scenario: BookkeepingScenario, ada: ScenarioBrowser) {
  const path = await scenario.invite(
    ada,
    "/w/analytical-engines",
    "charles@example.test",
    "member",
  );
  return (await scenario.acceptInvitation("charles@example.test", "Charles Babbage", { path }))
    .browser;
}

/** April's statement, after March's: Lady Byron's IBAN pays an advance, under her married name. */
function aprilStatement(march: FixtureStatement): FixtureStatement {
  return nextStatement(
    march,
    { id: `${YEAR}-04`, startDate: `${YEAR}-04-01`, endDate: `${YEAR}-04-30` },
    [
      {
        reference: `${YEAR}0402-001`,
        bookingDate: `${YEAR}-04-02`,
        amountCents: 50_000,
        counterparty: { name: "A. I. King", iban: "NL44RABO0123456789" },
        remittance: "Advance",
        information: "SEPA Overboeking",
      },
    ],
  );
}

test("statements are imported once, oldest first, each continuing the one before", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    const charles = await charlesJoins(scenario, ada);
    const journalId = find((await readBooks(ada)).journals, "BNK").id;
    const account = {
      intent: "add-bank-account",
      name: "Current account",
      code: "1000",
      journalId,
    };
    expect(await charles.submit(`${BOOKS}/bank`, { ...account, iban: ACCOUNT_IBAN })).toMatchObject(
      { status: 403 },
    );
    expect(
      await ada.submit(`${BOOKS}/bank`, { ...account, iban: "NL21 INGB 0001 2345 67" }),
    ).toMatchObject({
      actionData: { error: "Enter the account's IBAN, like NL91 ABNA 0417 1643 00." },
    });
    expect(
      await ada.submit(`${BOOKS}/bank`, { ...account, iban: ACCOUNT_IBAN, journalId: "missing" }),
    ).toMatchObject({
      actionData: {
        error: "Choose one of the books' journals to book the account's transactions in.",
      },
    });
    const current = await addCurrentAccount(ada);
    expect(
      await ada.submit(`${BOOKS}/bank`, { ...account, iban: ACCOUNT_IBAN, code: "1001" }),
    ).toMatchObject({
      actionData: { error: "The books already have a bank account with this IBAN." },
    });
    // The refused account added no ledger account either.
    expect((await readBooks(ada)).accounts.map((row) => row.code)).not.toContain("1001");

    const march = marchStatement(YEAR);
    const april = aprilStatement(march);
    const may = nextStatement(
      april,
      { id: `${YEAR}-05`, startDate: `${YEAR}-05-01`, endDate: `${YEAR}-05-31` },
      [],
    );
    expect(await importStatements(charles, current, "<html>A bank's page</html>")).toMatchObject({
      error: "This file is not a CAMT.053 bank statement.",
    });
    expect(
      await importStatements(charles, current, [{ ...march, iban: "NL44RABO0123456789" }]),
    ).toMatchObject({
      error: `Statement ${YEAR}-03 is of NL44RABO0123456789 in EUR, not of this bank account.`,
    });
    expect(
      await importStatements(
        charles,
        current,
        renderCamt053([march]).replace("4331.53", "4331.35"),
      ),
    ).toMatchObject({
      error: `Statement ${YEAR}-03's entries do not add up from its opening to its closing balance.`,
    });
    // A file cut short is refused, even where what is left of it adds up.
    const file = renderCamt053([march]);
    expect(
      await importStatements(charles, current, file.slice(0, file.indexOf("<Ntry>"))),
    ).toMatchObject({
      error: "This file is not a complete CAMT.053 bank statement: export it from your bank again.",
    });
    expect(
      await importStatements(
        charles,
        current,
        file.replace(`<BookgDt><Dt>${YEAR}-03-20`, `<BookgDt><Dt>${YEAR}-02-30`),
      ),
    ).toMatchObject({
      error: `Statement ${YEAR}-03 has an impossible date, ${YEAR}-02-30.`,
    });
    // A file missing April's statement imports nothing, not even March's.
    expect(await importStatements(charles, current, [march, may])).toMatchObject({
      error: `Statement ${YEAR}-05 does not open with the closing balance of the statement before it: import the statements between them first.`,
    });
    expect(await toBook(charles, current)).toEqual([]);

    expect(await importStatements(charles, current, [march])).toMatchObject({
      error: null,
      imported: { imported: 1, skipped: 0, transactions: 4 },
    });
    expect(await importStatements(charles, current, [april, march])).toMatchObject({
      imported: { imported: 1, skipped: 1, transactions: 1 },
    });
    expect(await importStatements(charles, current, [march])).toMatchObject({
      imported: { imported: 0, skipped: 1, transactions: 0 },
    });
    // Once imported, a statement is what it said then.
    expect(
      await importStatements(charles, current, file.replace("Payment INV-1", "Payment INV-2")),
    ).toMatchObject({
      error: `Statement ${YEAR}-03 says something else than when it was imported.`,
    });
    expect(
      await importStatements(charles, current, [{ ...march, id: `${YEAR}-03-again` }]),
    ).toMatchObject({
      error: `Statement ${YEAR}-03-again ends before the last imported statement: import statements oldest first.`,
    });

    const { bankAccount: imported } = await bankAccount(charles, current);
    expect(imported.lastStatement).toEqual({
      endDate: `${YEAR}-04-30`,
      closingBalanceMinor: BigInt(closingCents(april)),
    });
    // The balance the first statement opened with is booked once, like a transaction.
    expect(
      (await toBook(charles, current)).map((transaction) => [
        transaction.bookingDate,
        transaction.amountMinor,
        transaction.detail.type,
      ]),
    ).toEqual([
      [`${YEAR}-03-01`, 500_000n, "opening-balance"],
      [`${YEAR}-03-05`, 12_100n, "entry"],
      [`${YEAR}-03-20`, BigInt(-INVOICE.totalCents), "entry"],
      [`${YEAR}-03-31`, -1_250n, "entry"],
      [`${YEAR}-04-02`, 50_000n, "entry"],
    ]);
  });
});

test("payments are booked against what they pay, until the bank account adds up to the bank's balance", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    await addParty(ada, { name: "Lady Byron", role: "customer", code: "C001" });
    await addParty(ada, { name: INVOICE.supplier.name, role: "supplier", code: "S001" });
    let books = await readBooks(ada);
    const total = (INVOICE.totalCents / 100).toFixed(2);
    await post(ada, books, {
      journal: "SAL",
      date: `${YEAR}-03-01`,
      description: "Invoice 1",
      reference: "INV-1",
      lines: [
        { account: "1300", debit: "121.00", party: "C001" },
        { account: "8000", credit: "100.00" },
        { account: "1700", credit: "21.00" },
      ],
    });
    await post(ada, books, {
      journal: "PUR",
      date: INVOICE.invoiceDate.replace("2026", String(YEAR)),
      description: "Gear wheels and calibration",
      reference: INVOICE.number,
      lines: [
        { account: "7000", debit: total },
        { account: "1600", credit: total, party: "S001" },
      ],
    });
    const current = await addCurrentAccount(ada);
    await importStatements(ada, current, [marchStatement(YEAR)]);
    books = await readBooks(ada);
    const partyAccount = (code: string) =>
      find(
        books.parties.flatMap((party) => party.accounts),
        code,
      ).id;

    // Only the entries booking its transactions post to the bank account.
    expect(
      await post(ada, books, {
        journal: "GEN",
        date: `${YEAR}-03-10`,
        description: "Cash deposit",
        reference: "",
        lines: [
          { account: "1000", debit: "10.00" },
          { account: "0500", credit: "10.00" },
        ],
      }),
    ).toMatchObject({
      actionData: {
        error:
          "Bank accounts take only the entries booking their bank transactions: book what is owed here, and its payment from the bank transaction.",
      },
    });

    // Its lines come from the bank, which gives them no dimension values.
    await ada.submit(`${BOOKS}/settings`, {
      intent: "create-dimension",
      code: "CC",
      name: "Cost centre",
    });
    const costCentre = find((await readBooks(ada)).dimensions, "CC");
    expect(
      await ada.submit(`${BOOKS}/accounts/${find(books.accounts, "1000").id}`, {
        intent: "update-account",
        name: "Current account",
        status: "active",
        [`dimension.${costCentre.id}`]: "required",
      }),
    ).toMatchObject({
      actionData: {
        error:
          "A bank account's lines come from its bank, which gives them no dimension values: its account takes no dimension rules.",
      },
    });

    const [opening, byron, babbage, costs] = await toBook(ada, current);

    // Lady Byron pays INV-1, which her payment's description names.
    let page = await transactionPage(ada, byron.id);
    expect(page.partyAccountId).toBe(partyAccount("C001"));
    expect(page.items).toMatchObject([
      { entry: { reference: "INV-1" }, outstandingMinor: 12_100n },
    ]);
    expect(page.preselected).toEqual({ [page.items[0].id]: 12_100n });
    const invoice = page.items[0].id;
    expect(
      await ada.submit(`${BOOKS}/bank/transactions/${byron.id}`, {
        partyAccountId: partyAccount("C001"),
        settle: invoice,
        [`amount.${invoice}`]: "121.00",
      }),
    ).toMatchObject({ path: `${BOOKS}/bank/transactions/${byron.id}` });
    page = await transactionPage(ada, byron.id);
    expect(page.transaction.state).toMatchObject({ status: "booked" });

    // Paying a bill settles at most what is outstanding of it.
    page = await transactionPage(ada, babbage.id);
    expect(page.partyAccountId).toBe(partyAccount("S001"));
    const bill = page.items[0].id;
    expect(page.preselected).toEqual({ [bill]: BigInt(INVOICE.totalCents) });
    const payBill = { partyAccountId: partyAccount("S001"), settle: bill };
    expect(
      await ada.submit(`${BOOKS}/bank/transactions/${babbage.id}`, {
        ...payBill,
        [`amount.${bill}`]: "800.00",
      }),
    ).toMatchObject({
      actionData: { error: "The settlement exceeds the item's outstanding amount." },
    });
    await ada.submit(`${BOOKS}/bank/transactions/${babbage.id}`, {
      ...payBill,
      [`amount.${bill}`]: total,
    });

    // The bank's costs and the opening balance are booked with entries besides the bank's line.
    expect(
      await post(
        ada,
        books,
        {
          journal: "BNK",
          date: `${YEAR}-03-31`,
          description: "Bank costs",
          reference: "",
          lines: [{ account: "1000", debit: "12.50" }],
        },
        costs.id,
      ),
    ).toMatchObject({
      actionData: { error: "Book the transaction's amount on its bank account, 1000." },
    });
    expect(
      await post(
        ada,
        books,
        {
          journal: "BNK",
          date: `${YEAR}-03-31`,
          description: "Bank costs",
          reference: "",
          lines: [{ account: "4000", debit: "12.50" }],
        },
        costs.id,
      ),
    ).toMatchObject({ path: `${BOOKS}/bank/transactions/${costs.id}` });
    await post(
      ada,
      books,
      {
        journal: "BNK",
        date: `${YEAR}-03-01`,
        description: "Opening balance",
        reference: "",
        lines: [{ account: "0500", credit: "5000.00" }],
      },
      opening.id,
    );

    expect(await toBook(ada, current)).toEqual([]);
    const march = books.fiscalYears[0].periods[2].id;
    const [debits, credits] = (await trialBalance(ada, march))["1000"];
    expect(debits - credits).toBe(BigInt(closingCents(marchStatement(YEAR))));
    const entryPage = await ada.navigate(`${BOOKS}/entries/BNK/1`);
    expect(entryPage.loaderData["books/entry"]).toMatchObject({
      source: { label: "Bank transaction", name: "Lady Byron: Payment INV-1" },
    });

    // Her IBAN is hers now, whatever name it pays under; with nothing open, it stays open on her
    // account, an advance.
    await importStatements(ada, current, [aprilStatement(marchStatement(YEAR))]);
    const [advance] = await toBook(ada, current);
    page = await transactionPage(ada, advance.id);
    expect(page).toMatchObject({ suggested: [partyAccount("C001")], items: [] });
    await ada.submit(`${BOOKS}/bank/transactions/${advance.id}`, {
      partyAccountId: partyAccount("C001"),
    });
    expect(await toBook(ada, current)).toEqual([]);

    // Reversing a payment's entry makes it to book again, and what it paid owed again.
    expect(
      await ada.submit(`${BOOKS}/entries/BNK/1`, {
        intent: "reverse",
        postingDate: `${YEAR}-03-31`,
      }),
    ).toMatchObject({ path: `${BOOKS}/entries/BNK/6` });
    expect((await toBook(ada, current)).map((transaction) => transaction.id)).toEqual([byron.id]);
    page = await transactionPage(ada, byron.id);
    expect(page.items.map((item) => item.outstandingMinor)).toEqual([12_100n]);
  });
});

test("a payment starts settling the invoices its description names whole", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    await addParty(ada, { name: "Lady Byron", role: "customer", code: "C001" });
    const books = await readBooks(ada);
    for (const [date, reference] of [
      [`${YEAR}-03-01`, "INV-1"],
      [`${YEAR}-03-02`, "INV-10"],
    ]) {
      await post(ada, books, {
        journal: "SAL",
        date,
        description: `Invoice ${reference}`,
        reference,
        lines: [
          { account: "1300", debit: "121.00", party: "C001" },
          { account: "8000", credit: "121.00" },
        ],
      });
    }
    const current = await addCurrentAccount(ada);
    await importStatements(ada, current, [
      {
        id: `${YEAR}-03`,
        iban: ACCOUNT_IBAN,
        startDate: `${YEAR}-03-01`,
        endDate: `${YEAR}-03-31`,
        openingCents: 0,
        entries: [
          {
            reference: `${YEAR}0310-001`,
            bookingDate: `${YEAR}-03-10`,
            amountCents: 12_100,
            counterparty: { name: "Lady Byron", iban: "NL44RABO0123456789" },
            remittance: "inv-10 thank you",
            information: "SEPA Overboeking",
          },
        ],
      },
    ]);
    const [payment] = await toBook(ada, current);

    // INV-1 is due first and owes as much, but the payment names INV-10.
    const page = await transactionPage(ada, payment.id);
    const byReference = new Map(page.items.map((item) => [item.entry.reference, item.id]));
    expect(page.preselected).toEqual({ [byReference.get("INV-10")!]: 12_100n });
  });
});
