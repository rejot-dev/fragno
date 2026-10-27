import { assert, expect, test } from "vitest";

import type { BooksOutletContext } from "../../app/books/layout";
import {
  runBookkeepingScenario,
  type BookkeepingScenario,
} from "../../scenario/bookkeeping-scenario";

const CLIENT = "analytical-engines";

type Books = BooksOutletContext["books"];

/** A line of an `entries.post` input; customers and suppliers by code, amounts as decimals. */
function line(
  account: string,
  side: "debit" | "credit",
  amount: string,
  party: string | null = null,
) {
  return {
    account,
    side,
    amount,
    currency: null,
    functionalAmount: null,
    description: "",
    party,
    dueDate: null,
    dimensions: {},
  };
}

/** Ada's practice keeps the books of Analytical Engines; Charles keeps them with her as a member. */
async function practiceWithBooks(scenario: BookkeepingScenario) {
  const { ada, clientPath } = await scenario.practice();
  const books = await scenario.openAdministration(ada, clientPath, "Analytical Engines");
  const invitation = await scenario.invite(ada, clientPath, "charles@example.test", "member");
  await scenario.acceptInvitation("charles@example.test", "Charles Babbage", { path: invitation });
  return { ada, clientPath, books };
}

test("people's agents keep the books through Backoffice, within what the person may do", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, books } = await practiceWithBooks(scenario);
    const project = { organization: CLIENT, project: "Analytical Engines" };
    const adaAgent = scenario.agent({ email: "ada@example.test" }, project);
    const charlesAgent = scenario.agent({ email: "charles@example.test" }, project);
    const year = new Date().getUTCFullYear();

    expect(await charlesAgent.call("books.describe", {})).toMatchObject({
      status: 200,
      body: {
        functionalCurrency: "EUR",
        fiscalYears: [{ name: String(year), periods: { length: 12 } }],
        journals: [
          { code: "BNK" },
          { code: "GEN" },
          { code: "PUR" },
          { code: "SAL", entryCount: 0 },
        ],
      },
    });

    // Charles's agent invoices a new customer; the books' only receivable account is theirs.
    expect(
      await charlesAgent.call("parties.create", {
        party: { name: "Lady Byron" },
        role: "customer",
        code: "C001",
        controlAccount: null,
      }),
    ).toEqual({ status: 200, body: { role: "customer", code: "C001", controlAccount: "1300" } });
    const invoice = {
      journal: "SAL",
      postingDate: `${year}-03-10`,
      reference: "INV-1",
      description: "Invoice 1",
      lines: [
        line("1300", "debit", "121.00", "C001"),
        line("8000", "credit", "100"),
        line("1700", "credit", "21.00"),
      ],
    };
    expect(await charlesAgent.call("entries.post", invoice)).toEqual({
      status: 200,
      body: { journal: "SAL", number: 1 },
    });
    // Posting again, e.g. after a lost answer, does not post the invoice twice.
    expect(await charlesAgent.call("entries.post", invoice)).toEqual({
      status: 422,
      body: { message: "Entry SAL 1 already has reference INV-1." },
    });
    expect(
      await charlesAgent.call("entries.post", {
        ...invoice,
        reference: null,
        lines: [line("1300", "debit", "121.00"), invoice.lines[1], invoice.lines[2]],
      }),
    ).toEqual({ status: 422, body: { message: "Lines on control account 1300 need a party." } });

    await charlesAgent.call("entries.post", {
      journal: "BNK",
      postingDate: `${year}-03-20`,
      reference: null,
      description: "Payment invoice 1",
      lines: [line("1000", "debit", "121.00"), line("1300", "credit", "121.00", "C001")],
    });
    const items = (
      await charlesAgent.call("parties.open-items", { role: "customer", code: "C001" })
    ).body as { items: { id: string; side: string; outstanding: string }[] };
    const debit = items.items.find((item) => item.side === "debit");
    const credit = items.items.find((item) => item.side === "credit");
    assert(debit && credit);
    expect(
      await charlesAgent.call("settlements.create", {
        role: "customer",
        code: "C001",
        debitItem: debit.id,
        creditItem: credit.id,
        amount: null,
      }),
    ).toMatchObject({ status: 200, body: { amount: "121.00" } });

    // Entries name who the agent acted for, and the books add up.
    expect(await adaAgent.call("entries.get", { journal: "SAL", number: 1 })).toMatchObject({
      status: 200,
      body: {
        reference: "INV-1",
        postedBy: "Charles Babbage via Backoffice",
        lines: [
          { account: "1300", amount: "121.00", party: { role: "customer", code: "C001" } },
          { account: "8000", amount: "100.00", party: null },
          { account: "1700", amount: "21.00", party: null },
        ],
      },
    });
    expect(
      await adaAgent.call("reports.trial-balance", { fiscalYear: String(year), period: 3 }),
    ).toMatchObject({ status: 200, body: { totals: { debit: "242.00", credit: "242.00" } } });
    expect(
      await adaAgent.call("parties.open-items", { role: "customer", code: "C001" }),
    ).toMatchObject({
      body: { items: [{ outstanding: "0.00" }, { outstanding: "0.00" }] },
    });

    // Setting the books up is for owners and admins, as on Bookkeeping's pages.
    const rent = {
      code: "4100",
      name: "Rent",
      type: "expense",
      role: "ordinary",
      normalSide: null,
      currency: null,
      dimensionRules: { CC: "required" },
    };
    expect(await charlesAgent.call("accounts.create", rent)).toEqual({
      status: 403,
      body: { message: "Only owners and admins set up the books." },
    });
    await adaAgent.call("dimensions.create", { code: "CC", name: "Cost centre" });
    await adaAgent.call("dimension-values.create", { dimension: "CC", code: "LAB", name: "Lab" });
    expect(await adaAgent.call("accounts.create", rent)).toEqual({
      status: 200,
      body: { code: "4100" },
    });

    // A revaluation moves only the functional amount; a line needs at least one of the two.
    await adaAgent.call("currencies.add", { code: "USD", minorUnitDigits: 2 });
    const revaluation = (dollars: string, euros: string) => ({
      journal: "GEN",
      postingDate: `${year}-03-31`,
      reference: null,
      description: "Revaluation of dollars",
      lines: [
        { ...line("1000", "debit", dollars), currency: "USD", functionalAmount: euros },
        line("8000", "credit", euros),
      ],
    });
    expect(await charlesAgent.call("entries.post", revaluation("0", "4.20"))).toEqual({
      status: 200,
      body: { journal: "GEN", number: 1 },
    });
    expect(await charlesAgent.call("entries.post", revaluation("0", "0"))).toEqual({
      status: 422,
      body: { message: "A line needs an amount." },
    });
    // Amounts too large to keep exactly are refused, not rounded.
    expect(
      await charlesAgent.call("entries.post", {
        ...invoice,
        reference: "INV-2",
        lines: [
          line("1000", "debit", "90071992547409.93"),
          line("8000", "credit", "90071992547409.93"),
        ],
      }),
    ).toEqual({
      status: 422,
      body: { message: "Amounts are from 0 to 999999999999999 minor units." },
    });

    // Roles changed in Backoffice apply once Bookkeeping confirms the membership again.
    scenario.backoffice.admin.setRoles(CLIENT, "charles@example.test", ["admin"]);
    scenario.advanceTime(61_000);
    expect(await charlesAgent.call("journals.create", { code: "MEM", name: "Memorial" })).toEqual({
      status: 200,
      body: { code: "MEM" },
    });

    // People close periods, in Bookkeeping; an agent can only reopen them.
    const settings = await ada.navigate(`${books}/settings`);
    const { fiscalYears } = (settings.loaderData["books/layout"] as { books: Books }).books;
    await ada.submit(`${books}/settings`, {
      intent: "transition-period",
      periodId: fiscalYears[0].periods[3].id,
      transition: "close",
    });
    const rentPaid = {
      journal: "BNK",
      postingDate: `${year}-04-01`,
      reference: null,
      description: "Rent April",
      lines: [
        { ...line("4100", "debit", "500"), dimensions: { CC: "LAB" } },
        line("1000", "credit", "500"),
      ],
    };
    expect(await charlesAgent.call("entries.post", rentPaid)).toEqual({
      status: 422,
      body: { message: `No open period contains ${year}-04-01.` },
    });
    await adaAgent.call("periods.reopen", { fiscalYear: String(year), period: 4 });
    expect(await charlesAgent.call("entries.post", rentPaid)).toEqual({
      status: 200,
      body: { journal: "BNK", number: 2 },
    });

    // Automations without a person behind them read the books but do not change them.
    const automation = scenario.agent("installation", project);
    expect(
      await automation.call("accounts.lines", { account: "4100", cursor: null }),
    ).toMatchObject({
      status: 200,
      body: { lines: [{ journal: "BNK", entry: 2, amount: "500.00" }] },
    });
    expect(
      await automation.call("entries.post", { ...rentPaid, postingDate: `${year}-04-02` }),
    ).toEqual({
      status: 403,
      body: {
        message:
          "Automations without a person behind them read the books and propose documents' entries; only people change the books.",
      },
    });
  });
});

test("actions reach only the books of the administration Backoffice signed the call for", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await practiceWithBooks(scenario);
    await scenario.openAdministration(ada, clientPath, "Difference Engines");
    scenario.backoffice.admin.createProject(CLIENT, "Marketing");
    const ada$ = { email: "ada@example.test" };
    const analytical = scenario.agent(ada$, {
      organization: CLIENT,
      project: "Analytical Engines",
    });
    const difference = scenario.agent(ada$, {
      organization: CLIENT,
      project: "Difference Engines",
    });
    const year = new Date().getUTCFullYear();
    const entry = {
      journal: "GEN",
      postingDate: `${year}-03-10`,
      reference: null,
      description: "Capital",
      lines: [line("1000", "debit", "1000"), line("0500", "credit", "1000")],
    };

    await analytical.call("entries.post", entry);
    expect(await difference.call("entries.get", { journal: "GEN", number: 1 })).toEqual({
      status: 422,
      body: { message: "Journal GEN has no entry 1." },
    });
    expect(
      await scenario
        .agent(ada$, { organization: CLIENT, project: "Marketing" })
        .call("books.describe", {}),
    ).toEqual({
      status: 403,
      body: { message: "This Backoffice project is not an administration in Bookkeeping." },
    });
    const workspace = scenario.agent(ada$, { organization: CLIENT, project: null });
    expect(await workspace.call("books.describe", {})).toEqual({
      status: 403,
      body: { message: "Books actions run in an administration's Backoffice project." },
    });
    expect(await workspace.call("organization.get", {})).toMatchObject({ status: 200 });

    // Backoffice's signature covers the exact body and expires within a minute.
    const signed = await analytical.request("entries.post", entry);
    const tampered = new Request(signed, {
      method: "POST",
      body: JSON.stringify({
        type: "action",
        actionId: "entries.post",
        input: { ...entry, description: "Something else" },
      }),
    });
    expect(await analytical.send(tampered)).toEqual({
      status: 401,
      body: { message: "App action token does not sign this request body." },
    });
    const late = await analytical.request("entries.post", entry);
    scenario.advanceTime(61_000);
    expect(await analytical.send(late)).toEqual({
      status: 401,
      body: { message: "App action token expired." },
    });
    expect(await analytical.call("entries.list", { journal: "GEN", cursor: null })).toMatchObject({
      body: { entries: [{ number: 1 }], cursor: null },
    });

    // Changing the books needs a person Bookkeeping knows by name.
    scenario.backoffice.addUser({ email: "lovelace@example.test", name: "" });
    scenario.backoffice.admin.addMember(CLIENT, "lovelace@example.test", ["member"]);
    const stranger = scenario.agent(
      { email: "lovelace@example.test" },
      { organization: CLIENT, project: "Analytical Engines" },
    );
    expect(await stranger.call("entries.post", entry)).toEqual({
      status: 403,
      body: { message: "Sign in to Bookkeeping once, so it knows who keeps these books." },
    });
  });
});
