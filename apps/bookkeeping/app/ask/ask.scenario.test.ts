import { assert, expect, test } from "vitest";

import { runBookkeepingScenario, type ScenarioBrowser } from "../../scenario/bookkeeping-scenario";

const CLIENT = "analytical-engines";
const ADMINISTRATION = "Analytical Engines";
const BOOKS = "/w/analytical-engines/a/analytical-engines";
const AGENT = `${BOOKS}/ask/agent`;

async function ask(browser: ScenarioBrowser, requestId: string, content: string) {
  const response = await browser.fetchResource(AGENT, { intent: "ask", requestId, content });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json();
}

async function askPage(browser: ScenarioBrowser) {
  const page = await browser.navigate(`${BOOKS}/ask`);
  assert.equal(page.status, 200, JSON.stringify(page));
  return page.loaderData["ask/ask"] as { agent: { ok: boolean; provisioned?: boolean } };
}

test("everyone in the workspace asks the administration's agent, which reads the books as Bookkeeping", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, ADMINISTRATION);
    const invitation = await scenario.invite(ada, clientPath, "charles@example.test", "member");
    const { browser: charles } = await scenario.acceptInvitation(
      "charles@example.test",
      "Charles Babbage",
      { path: invitation },
    );

    // Opening the page defines the agent in the administration's own project, so it reads only
    // these books, and asks nothing yet, so its conversation has not started.
    expect(await askPage(charles)).toEqual({ agent: { ok: true, provisioned: false } });
    expect(scenario.backoffice.agents(CLIENT, ADMINISTRATION)).toMatchObject([
      {
        agentName: "books",
        permissions: ["upload.read", "models.extract", "integrations.read", "integrations.execute"],
      },
    ]);

    // A client's member and the firm's owner ask in one conversation, as Bookkeeping's
    // installation: the agent's calls to Bookkeeping then read the books and change nothing.
    expect(await ask(charles, "rent", "What did we spend on rent?")).toEqual({ error: null });
    expect(await askPage(charles)).toEqual({ agent: { ok: true, provisioned: true } });
    expect(await ask(ada, "vat", "And on VAT?")).toEqual({ error: null });
    // Asking again under a request ID asks once.
    expect(await ask(ada, "vat", "And on VAT?")).toEqual({ error: null });
    const asked = {
      agentName: "books",
      subagent: false,
      prompter: "installation",
      // As in Backoffice's chat, a question joins a running turn and resumes a stopped agent.
      whenBusy: "steer",
      whenPaused: "resume",
    };
    expect(scenario.backoffice.prompts(CLIENT, ADMINISTRATION)).toEqual([
      { ...asked, requestId: "rent", content: "What did we spend on rent?", status: "queued" },
      { ...asked, requestId: "vat", content: "And on VAT?", status: "queued" },
    ]);

    // Stopping pauses the agent; resuming, or asking, starts it again.
    const control = async (intent: "stop" | "resume") =>
      await (await charles.fetchResource(AGENT, { intent })).json();
    expect(await control("stop")).toEqual({ error: null });
    assert(scenario.backoffice.agentStopped(CLIENT, ADMINISTRATION, "books"));
    expect(await control("resume")).toEqual({ error: null });
    assert(!scenario.backoffice.agentStopped(CLIENT, ADMINISTRATION, "books"));
    await control("stop");
    await ask(charles, "balance", "What is in the bank?");
    assert(!scenario.backoffice.agentStopped(CLIENT, ADMINISTRATION, "books"));

    // An empty question asks nothing.
    const empty = await charles.fetchResource(AGENT, {
      intent: "ask",
      requestId: "x",
      content: " ",
    });
    assert.equal(empty.status, 400);
    expect(await empty.json()).toEqual({ error: "Write a question before sending." });
  });
});

test("the chat follows the conversation over the agent's socket with a ticket asked for as the person", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, ADMINISTRATION);
    await askPage(ada);
    await ask(ada, "rent", "What did we spend on rent?");

    const urls = await Promise.all(
      [1, 2].map(async () => {
        const response = await ada.download(AGENT);
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        return new URL(((await response.json()) as { url: string }).url);
      }),
    );
    for (const url of urls) {
      assert.equal(url.origin, "https://backoffice.test");
      expect(url.pathname).toMatch(/^\/api\/v0\/scopes\/project:[^/]+\/pi\.agent\.watch$/u);
      assert.equal(url.searchParams.get("agentName"), "books");
      // The ticket is the person's, so Backoffice checks they may read the agent.
      expect(
        scenario.backoffice.watchTicket(CLIENT, ADMINISTRATION, url.searchParams.get("ticket")!),
      ).toEqual({ agentName: "books", watcher: "ada@example.test" });
    }
    // Each connection gets a ticket of its own.
    assert.notEqual(urls[0].searchParams.get("ticket"), urls[1].searchParams.get("ticket"));
  });
});

test("a definition the client's members changed in Backoffice is theirs to keep", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, ADMINISTRATION);
    await askPage(ada);
    const [defined] = scenario.backoffice.agents(CLIENT, ADMINISTRATION);
    const changed = { ...defined, instructions: `${defined.instructions}\n\nAnswer in Dutch.` };
    scenario.backoffice.admin.defineAgent(CLIENT, ADMINISTRATION, changed);

    await askPage(ada);
    expect(scenario.backoffice.agents(CLIENT, ADMINISTRATION)).toEqual([changed]);
  });
});
