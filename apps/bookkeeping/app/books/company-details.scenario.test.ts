import { assert, expect, test } from "vitest";

import {
  runBookkeepingScenario,
  type ScenarioBrowser,
  type ScenarioPage,
} from "../../scenario/bookkeeping-scenario";
import { AGENT_PACKAGES } from "../../workers/backoffice/agents";

const CLIENT = "analytical-engines";
const ADMINISTRATION = "Analytical Engines";
const BOOKS = "/w/analytical-engines/a/analytical-engines";

type PartyPage = {
  details: {
    registrationNumber: string | null;
    vatNumber: string | null;
    iban: string | null;
    address: string | null;
    updatedBy: string | null;
  };
  lookup: unknown;
};

function partyPage(page: ScenarioPage): PartyPage {
  assert.equal(page.status, 200, JSON.stringify(page));
  return page.loaderData["books/party-account"] as PartyPage;
}

/** Starts a lookup from the supplier's page, and returns its request ID and the page it opened. */
async function lookUp(browser: ScenarioBrowser, path: string) {
  const page = await browser.submit(path, { intent: "look-up-details", retrying: "" });
  const requestId = new URL(page.path, "https://bookkeeping.test").searchParams.get("lookup");
  assert(requestId, JSON.stringify(page));
  return { requestId, page };
}

test("a supplier's company details are filled in from the person's own connections, checked, and saved", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, ADMINISTRATION);
    expect(
      await ada.submit(`${BOOKS}/parties`, {
        intent: "add-party-account",
        partyId: "new",
        name: "Babbage Works",
        role: "supplier",
        code: "S001",
        controlAccountId: "usual",
      }),
    ).toMatchObject({ actionData: { error: null } });
    const parties = await ada.navigate(BOOKS);
    const supplier = (
      parties.loaderData["books/layout"] as {
        books: { parties: { name: string; accounts: { id: string }[] }[] };
      }
    ).books.parties.find((party) => party.name === "Babbage Works")!.accounts[0].id;
    const path = `${BOOKS}/parties/${supplier}`;

    expect(partyPage(await ada.navigate(path))).toMatchObject({
      details: { registrationNumber: null, vatNumber: null, iban: null, address: null },
      lookup: null,
    });

    // The lookup runs as Ada, in a conversation of its own, naming her so the agent reaches her
    // own connections.
    const first = await lookUp(ada, path);
    expect(partyPage(first.page).lookup).toEqual({ status: "looking" });
    expect(
      scenario.backoffice.subagentPrompts(CLIENT, ADMINISTRATION).map((prompt) => ({
        agentName: prompt.agentName,
        requestId: prompt.requestId,
        prompter: prompt.prompter,
        content: prompt.content,
      })),
    ).toEqual([
      {
        agentName: "company-details",
        requestId: first.requestId,
        prompter: "ada@example.test",
        content: `Look up the company details of the supplier "Babbage Works" for Ada Lovelace, whose user ID is \`${scenario.backoffice.userId("ada@example.test")}\`.`,
      },
    ]);

    // When Backoffice started the lookup but its answer was lost, retrying asks with the same
    // request ID, so it follows that lookup instead of starting a second.
    scenario.backoffice.failNextResponse("pi.prompt.submit");
    const lost = await ada.submit(path, { intent: "look-up-details", retrying: "" });
    const { requestId: lostId } = lost.actionData as { error: string; requestId: string };
    expect(lost.actionData).toMatchObject({ error: "Backoffice could not be reached." });
    const retried = await ada.submit(path, { intent: "look-up-details", retrying: lostId });
    expect(new URL(retried.path, "https://bookkeeping.test").searchParams.get("lookup")).toBe(
      lostId,
    );
    expect(
      scenario.backoffice.subagentPrompts(CLIENT, ADMINISTRATION).map((prompt) => prompt.requestId),
    ).toEqual([first.requestId, lostId]);
    // A retry names a lookup of this party only.
    expect(
      (await ada.submit(path, { intent: "look-up-details", retrying: "company-details:other:x" }))
        .actionData,
    ).toMatchObject({ error: "This lookup is not about this customer or supplier." });

    // Her personal workspace refused: Bookkeeping links where she lets it in, for this client only.
    const orgId = scenario.backoffice.organization(CLIENT).id;
    const allow = `/backoffice/apps/bookkeeping-app/member-reach/${orgId}`;
    scenario.backoffice.settlePrompt(first.requestId, {
      status: "completed",
      answer: JSON.stringify({
        status: "refused",
        message: `This app may not act in your personal workspace for this organization. You can let it in at ${allow} in Leyway, once the organization lets the app ask its members.`,
      }),
    });
    expect(partyPage(await ada.navigate(first.page.path)).lookup).toMatchObject({
      status: "refused",
      allowUrl: `https://backoffice.test${allow}`,
    });

    // A lookup of another party, or no lookup at all, reads nothing.
    expect(
      partyPage(await ada.navigate(`${path}?lookup=company-details:other:x`)).lookup,
    ).toMatchObject({ status: "failed" });

    // Once she allowed it, it finds the details, which fill in the form for her to check.
    const second = await lookUp(ada, path);
    scenario.backoffice.settlePrompt(second.requestId, {
      status: "completed",
      answer: `\`\`\`json\n${JSON.stringify({
        status: "found",
        source: "KvK",
        details: {
          registrationNumber: " 12345678 ",
          vatNumber: "NL001234567B01",
          iban: "nl91 abna 0417 1643 00",
          address: "Keizersgracht 1\n1015 AA Amsterdam",
        },
      })}\n\`\`\``,
    });
    expect(partyPage(await ada.navigate(second.page.path))).toMatchObject({
      lookup: {
        status: "found",
        source: "KvK",
        details: {
          registrationNumber: "12345678",
          vatNumber: "NL001234567B01",
          iban: "NL91ABNA0417164300",
          address: "Keizersgracht 1 1015 AA Amsterdam",
        },
      },
      // Nothing is saved until she saves it.
      details: { registrationNumber: null },
    });

    const filledIn = {
      intent: "save-details",
      registrationNumber: "12345678",
      vatNumber: "NL001234567B01",
      iban: "NL91 ABNA 0417 1643 00",
      address: "Keizersgracht 1 1015 AA Amsterdam",
    };
    expect(await ada.submit(second.page.path, { ...filledIn, iban: "NL00 1234" })).toMatchObject({
      actionData: { intent: "save-details", error: "Enter the IBAN as the bank gives it." },
    });
    const saved = await ada.submit(second.page.path, filledIn);
    expect(saved.path).toBe(path);
    expect(partyPage(saved)).toMatchObject({
      lookup: null,
      details: {
        registrationNumber: "12345678",
        vatNumber: "NL001234567B01",
        iban: "NL91ABNA0417164300",
        address: "Keizersgracht 1 1015 AA Amsterdam",
        updatedBy: "Ada Lovelace",
      },
    });

    // An answer naming another organization's page, or none, links nothing.
    const third = await lookUp(ada, path);
    scenario.backoffice.settlePrompt(third.requestId, {
      status: "completed",
      answer: JSON.stringify({
        status: "refused",
        message: "Refused at /backoffice/apps/bookkeeping-app/member-reach/another-org.",
      }),
    });
    expect(partyPage(await ada.navigate(third.page.path)).lookup).toMatchObject({
      status: "refused",
      allowUrl: null,
    });
    // Nor does one naming another app's page for this organization.
    const otherApp = await lookUp(ada, path);
    scenario.backoffice.settlePrompt(otherApp.requestId, {
      status: "completed",
      answer: JSON.stringify({
        status: "refused",
        message: `Refused at /backoffice/apps/other-app/member-reach/${orgId}.`,
      }),
    });
    expect(partyPage(await ada.navigate(otherApp.page.path)).lookup).toMatchObject({
      status: "refused",
      allowUrl: null,
    });
    // An IBAN the source gave that is not one is shown as given, not as the saved IBAN.
    const invalid = await lookUp(ada, path);
    scenario.backoffice.settlePrompt(invalid.requestId, {
      status: "completed",
      answer: JSON.stringify({
        status: "found",
        source: "KvK",
        details: { registrationNumber: null, vatNumber: null, iban: "NL00 1234", address: null },
      }),
    });
    expect(partyPage(await ada.navigate(invalid.page.path)).lookup).toEqual({
      status: "found",
      source: "KvK",
      details: { registrationNumber: null, vatNumber: null, iban: null, address: null },
      invalidIban: "NL00 1234",
    });
    const fourth = await lookUp(ada, path);
    scenario.backoffice.settlePrompt(fourth.requestId, {
      status: "completed",
      answer: "I could not find it.",
    });
    expect(partyPage(await ada.navigate(fourth.page.path)).lookup).toMatchObject({
      status: "failed",
      reason: "The lookup answered something unreadable.",
    });

    // Once the client's owners removed the agent's package while Bookkeeping was uninstalled, a
    // lookup installs it again, and asks the agent.
    scenario.backoffice.admin.uninstall(CLIENT);
    scenario.backoffice.admin.uninstallPackage(
      CLIENT,
      ADMINISTRATION,
      "app:bookkeeping#books-agent",
    );
    scenario.backoffice.admin.reinstall(CLIENT);
    const again = await lookUp(ada, path);
    expect(partyPage(again.page).lookup).toEqual({ status: "looking" });
    expect(scenario.backoffice.installedPackages(CLIENT, ADMINISTRATION)).toEqual([
      { listingId: "app:bookkeeping#books-agent", version: AGENT_PACKAGES.books.version },
    ]);
  });
});
