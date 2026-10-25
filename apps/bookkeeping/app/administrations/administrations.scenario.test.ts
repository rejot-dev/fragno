import { assert, expect, test } from "vitest";

import {
  runBookkeepingScenario,
  type BookkeepingScenario,
  type ScenarioBrowser,
} from "../../scenario/bookkeeping-scenario";

/** The new-administration form as the page renders it for `browser`. */
async function openNewAdministration(browser: ScenarioBrowser) {
  const page = await browser.navigate("/w/analytical-engines/administrations/new");
  return page.loaderData["administrations/new"] as { externalId: string; suggestedName: string };
}

/** Ada invites Charles, the client, as a member of Analytical Engines, and he joins. */
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

test("a client's owner sets up its books, and every member opens them", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await scenario.practice();
    expect(await ada.navigate("/w/analytical-engines")).toMatchObject({
      loaderData: { "clients/overview": { administrations: [], canCreate: true } },
    });

    const form = await openNewAdministration(ada);
    assert.equal(form.suggestedName, "Analytical Engines");
    const submitted = {
      externalId: form.externalId,
      name: "Analytical Engines",
      functionalCurrency: "EUR",
    };
    expect(
      await ada.submit("/w/analytical-engines/administrations/new", { ...submitted, name: " " }),
    ).toMatchObject({ actionData: { error: "Enter the administration's name." } });
    expect(await ada.submit("/w/analytical-engines/administrations/new", submitted)).toMatchObject({
      path: "/w/analytical-engines/a/analytical-engines",
      loaderData: {
        "books/layout": {
          books: { name: "Analytical Engines", functionalCurrency: "EUR" },
        },
      },
    });
    // Submitting the same form again, e.g. after a lost response, finds what the first made.
    expect(await ada.submit("/w/analytical-engines/administrations/new", submitted)).toMatchObject({
      path: "/w/analytical-engines/a/analytical-engines",
    });
    expect(scenario.backoffice.organization("analytical-engines").projects).toEqual([
      "Analytical Engines",
    ]);

    // A second business gets its own books.
    const second = await openNewAdministration(ada);
    assert.equal(second.suggestedName, "");
    await ada.submit("/w/analytical-engines/administrations/new", {
      externalId: second.externalId,
      name: "Difference Engines",
      functionalCurrency: "GBP",
    });
    expect(await ada.navigate("/w/analytical-engines/a/difference-engines")).toMatchObject({
      loaderData: {
        "books/layout": {
          books: { name: "Difference Engines", functionalCurrency: "GBP" },
        },
      },
    });

    const charles = await charlesJoins(scenario, ada);
    expect(await charles.navigate("/w/analytical-engines")).toMatchObject({
      loaderData: {
        "clients/overview": {
          administrations: [{ name: "Analytical Engines" }, { name: "Difference Engines" }],
          canCreate: false,
        },
      },
    });
    expect(await charles.navigate("/w/analytical-engines/a/difference-engines")).toMatchObject({
      loaderData: { "books/layout": { books: { name: "Difference Engines" } } },
    });
  });
});

test("only owners and admins create administrations, and only a client's members open them", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, firmPath } = await scenario.practice();
    const { externalId } = await openNewAdministration(ada);
    await ada.submit("/w/analytical-engines/administrations/new", {
      externalId,
      name: "Analytical Engines",
      functionalCurrency: "EUR",
    });

    const charles = await charlesJoins(scenario, ada);
    expect(await charles.navigate("/w/analytical-engines/administrations/new")).toMatchObject({
      status: 403,
    });
    expect(
      await charles.submit("/w/analytical-engines/administrations/new", {
        externalId: crypto.randomUUID(),
        name: "Charles's Books",
        functionalCurrency: "EUR",
      }),
    ).toMatchObject({ status: 403 });
    expect(scenario.backoffice.organization("analytical-engines").projects).toEqual([
      "Analytical Engines",
    ]);

    // Eve is the firm's other client; she opens only her own books.
    await scenario.createClient(ada, firmPath, "Eavesdropping");
    const path = await scenario.invite(ada, "/w/eavesdropping", "eve@example.test", "member");
    const { browser: eve } = await scenario.acceptInvitation("eve@example.test", "Eve", { path });
    expect(await eve.navigate("/w/analytical-engines/a/analytical-engines")).toMatchObject({
      status: 404,
    });
    expect(await eve.navigate("/w/eavesdropping/a/analytical-engines")).toMatchObject({
      status: 404,
    });
  });
});

test("creating an administration while Backoffice is down can be submitted again", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await scenario.practice();
    const { externalId } = await openNewAdministration(ada);
    const submitted = { externalId, name: "Analytical Engines", functionalCurrency: "EUR" };
    scenario.backoffice.setReachable(false);
    expect(await ada.submit("/w/analytical-engines/administrations/new", submitted)).toMatchObject({
      status: 503,
    });
    expect(await ada.navigate("/w/analytical-engines")).toMatchObject({
      loaderData: { "clients/overview": { administrations: [] } },
    });

    scenario.backoffice.setReachable(true);
    expect(await ada.submit("/w/analytical-engines/administrations/new", submitted)).toMatchObject({
      path: "/w/analytical-engines/a/analytical-engines",
    });
  });
});
