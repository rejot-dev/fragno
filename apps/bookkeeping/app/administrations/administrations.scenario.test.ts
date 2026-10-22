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

/** Ada invites Charles as a member, and he joins. */
async function charlesJoins(scenario: BookkeepingScenario, ada: ScenarioBrowser) {
  const invited = await ada.submit("/w/analytical-engines/members", {
    email: "charles@example.test",
    role: "member",
  });
  const invitationPath = new URL((invited.actionData as { link: string }).link).pathname;
  scenario.backoffice.addUser({ email: "charles@example.test", name: "Charles Babbage" });
  const charles = scenario.browser();
  await charles.signIn("charles@example.test", invitationPath);
  await charles.submit(invitationPath, {});
  return charles;
}

test("an owner sets up their business's books, and every member opens them", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const ada = await scenario.signUp({
      email: "ada@example.test",
      name: "Ada Lovelace",
      businessName: "Analytical Engines",
    });
    expect(await ada.navigate("/w/analytical-engines")).toMatchObject({
      loaderData: { "workspace/overview": { administrations: [], canCreate: true } },
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
        "administrations/administration": {
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
        "administrations/administration": {
          books: { name: "Difference Engines", functionalCurrency: "GBP" },
        },
      },
    });

    const charles = await charlesJoins(scenario, ada);
    expect(await charles.navigate("/w/analytical-engines")).toMatchObject({
      loaderData: {
        "workspace/overview": {
          administrations: [{ name: "Analytical Engines" }, { name: "Difference Engines" }],
          canCreate: false,
        },
      },
    });
    expect(await charles.navigate("/w/analytical-engines/a/difference-engines")).toMatchObject({
      loaderData: { "administrations/administration": { books: { name: "Difference Engines" } } },
    });
  });
});

test("only owners and admins create administrations, and only members open them", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const ada = await scenario.signUp({
      email: "ada@example.test",
      name: "Ada Lovelace",
      businessName: "Analytical Engines",
    });
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

    const eve = await scenario.signUp({
      email: "eve@example.test",
      name: "Eve",
      businessName: "Eavesdropping",
    });
    expect(await eve.navigate("/w/analytical-engines/a/analytical-engines")).toMatchObject({
      status: 404,
    });
    // Nor through her own workspace.
    expect(await eve.navigate("/w/eavesdropping/a/analytical-engines")).toMatchObject({
      status: 404,
    });
  });
});

test("creating an administration while Backoffice is down can be submitted again", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const ada = await scenario.signUp({
      email: "ada@example.test",
      name: "Ada Lovelace",
      businessName: "Analytical Engines",
    });
    const { externalId } = await openNewAdministration(ada);
    const submitted = { externalId, name: "Analytical Engines", functionalCurrency: "EUR" };
    scenario.backoffice.setReachable(false);
    expect(await ada.submit("/w/analytical-engines/administrations/new", submitted)).toMatchObject({
      status: 503,
    });
    expect(await ada.navigate("/w/analytical-engines")).toMatchObject({
      loaderData: { "workspace/overview": { administrations: [] } },
    });

    scenario.backoffice.setReachable(true);
    expect(await ada.submit("/w/analytical-engines/administrations/new", submitted)).toMatchObject({
      path: "/w/analytical-engines/a/analytical-engines",
    });
  });
});
