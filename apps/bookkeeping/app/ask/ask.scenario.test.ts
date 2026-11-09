import { assert, expect, test } from "vitest";

import {
  runBookkeepingScenario,
  type BookkeepingScenario,
  type ScenarioBrowser,
} from "../../scenario/bookkeeping-scenario";

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

    // Opening the administration installed its agent's package in the administration's own
    // project, so the agent reads only these books. Opening the page asks nothing yet, so its
    // conversation has not started.
    expect(await askPage(charles)).toEqual({ agent: { ok: true, provisioned: false } });
    expect(scenario.backoffice.agents(CLIENT, ADMINISTRATION)).toMatchObject([
      {
        agentName: "books",
        permissions: ["upload.read", "models.extract", "integrations.read", "integrations.execute"],
        steward: { kind: "package", listingId: "app:bookkeeping#books-agent" },
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

test("the agent's package is Bookkeeping's while it is installed, and opening the chat installs it again once gone", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, ADMINISTRATION);
    expect(scenario.backoffice.installedPackages(CLIENT, ADMINISTRATION)).toEqual([
      { listingId: "app:bookkeeping#books-agent", version: "1.0.1" },
    ]);

    // Members cannot uninstall the package while Bookkeeping is installed. Once its owners
    // uninstall Bookkeeping they may, and the package's agent goes with it.
    const listingId = "app:bookkeeping#books-agent";
    expect(() =>
      scenario.backoffice.admin.uninstallPackage(CLIENT, ADMINISTRATION, listingId),
    ).toThrow("Uninstall the app to remove it.");
    scenario.backoffice.admin.uninstall(CLIENT);
    scenario.backoffice.admin.uninstallPackage(CLIENT, ADMINISTRATION, listingId);
    expect(scenario.backoffice.agents(CLIENT, ADMINISTRATION)).toEqual([]);
    scenario.backoffice.admin.reinstall(CLIENT);

    expect(await askPage(ada)).toEqual({ agent: { ok: true, provisioned: false } });
    expect(scenario.backoffice.installedPackages(CLIENT, ADMINISTRATION)).toEqual([
      { listingId: "app:bookkeeping#books-agent", version: "1.0.1" },
    ]);
    expect(await ask(ada, "rent", "What did we spend on rent?")).toEqual({ error: null });
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

test("the chat loads what came before the newest compaction, a page at a time, as the person", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, ADMINISTRATION);
    await askPage(ada);
    await ask(ada, "rent", "What did we spend on rent?");
    const entries = Array.from({ length: 150 }, (_, index) => ({ id: index + 1 }));
    scenario.backoffice.setHistory(CLIENT, ADMINISTRATION, "books", entries);

    const page = async (query: string) => {
      const response = await ada.download(`${BOOKS}/ask/history?${query}`);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      return (await response.json()) as { entries: { id: number }[]; cursor: string | null };
    };
    // Newest first from where the active context begins, then on from each page's cursor.
    const newest = await page("before=121");
    expect(newest.entries.map(({ id }) => id)).toEqual(
      Array.from({ length: 100 }, (_, index) => 120 - index),
    );
    assert(newest.cursor !== null);
    const oldest = await page(`before=121&cursor=${newest.cursor}`);
    expect(oldest).toEqual({
      entries: Array.from({ length: 20 }, (_, index) => ({ id: 20 - index })),
      cursor: null,
    });
    // Backoffice checks the person may read the agent, as for its socket.
    expect(scenario.backoffice.historyReaders(CLIENT, ADMINISTRATION)).toEqual([
      { agentName: "books", reader: "ada@example.test" },
      { agentName: "books", reader: "ada@example.test" },
    ]);

    const unnamed = await ada.download(`${BOOKS}/ask/history`);
    assert.equal(unnamed.status, 400);
  });
});

test("files a question carries become documents, which the agent reads and the firm's bookkeeper is asked about", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, ADMINISTRATION);
    await askPage(ada);

    // Sending uploads each file as a document under the ID the chat chose, so a retry records it
    // once, and asks the firm's bookkeeper about it, as the documents page does.
    const documentId = crypto.randomUUID();
    const upload = async () => {
      const form = new FormData();
      form.set("documentId", documentId);
      form.set(
        "file",
        new File([new TextEncoder().encode("%PDF-1.7\nreceipt\n%%EOF\n")], "Receipt March.pdf", {
          type: "application/pdf",
        }),
      );
      return await (await ada.fetchResource(`${BOOKS}/ask/documents`, form)).json();
    };
    expect(await upload()).toEqual({ error: null });
    expect(await upload()).toEqual({ error: null });
    expect(scenario.backoffice.prompts("lovelace-co", "Bookkeeping agent")).toMatchObject([
      { agentName: "bookkeeper", requestId: expect.stringContaining(`:${documentId}:upload`) },
    ]);

    // The question names the documents' files by their blobs in the administration's project,
    // where the agent reads them, as Backoffice's chat names a message's files.
    const asked = await ada.fetchResource(AGENT, {
      intent: "ask",
      requestId: "receipt",
      content: "Is this booked?",
      documents: documentId,
    });
    expect(await asked.json()).toEqual({ error: null });
    const [prompt] = scenario.backoffice.prompts(CLIENT, ADMINISTRATION);
    expect(prompt.content).toMatch(
      new RegExp(
        `^Is this booked\\?\n\n<backoffice-attachments>\n<blob key="documents/${documentId}/[^/"]+/Receipt-March\\.pdf" type="application/pdf" size="23"/>\n</backoffice-attachments>$`,
        "u",
      ),
    );

    // A file alone asks too; a document the books do not have asks nothing.
    const filesOnly = await ada.fetchResource(AGENT, {
      intent: "ask",
      requestId: "file",
      content: "",
      documents: documentId,
    });
    expect(await filesOnly.json()).toEqual({ error: null });
    const unknown = await ada.fetchResource(AGENT, {
      intent: "ask",
      requestId: "unknown",
      content: "And this?",
      documents: crypto.randomUUID(),
    });
    expect(await unknown.json()).toEqual({
      error: "A file of this message is not among the books' documents. Attach it again.",
    });
    expect(scenario.backoffice.prompts(CLIENT, ADMINISTRATION)).toHaveLength(2);
  });
});

test("the assistant asks the firm what the books cannot answer, and the firm's answer comes into the conversation", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, firmPath, clientPath } = await scenario.practice();
    await scenario.openAdministration(ada, clientPath, ADMINISTRATION);
    await askPage(ada);

    // The client's agent asks as Bookkeeping's installation, which only reads the books otherwise.
    const assistant = scenario.agent("installation", {
      organization: CLIENT,
      project: ADMINISTRATION,
    });
    const asked = await assistant.call("firm.ask", {
      question: "Why was the March rent booked twice?",
    });
    assert.equal(asked.status, 200, JSON.stringify(asked));
    const { question: id } = asked.body as { question: string };

    // Everyone in the firm reads it on its dashboard, with where it was asked.
    const dashboard = async () =>
      (
        (await ada.navigate(firmPath)).loaderData["firms/dashboard"] as {
          questions: unknown[];
        }
      ).questions;
    expect(await dashboard()).toEqual([
      {
        id,
        question: "Why was the March rent booked twice?",
        askedAt: expect.any(Number),
        client: { slug: CLIENT, name: ADMINISTRATION },
        administration: { slug: "analytical-engines", name: ADMINISTRATION },
        answer: null,
      },
    ]);

    // The answer goes into the administration's conversation, for the agent to pass on, once.
    const answer = async () =>
      // The dashboard is the firm's index page, whose forms post to `?index`.
      (
        await ada.submit(`${firmPath}?index`, {
          question: id,
          answer: "The second is the deposit; it is booked to 1500 next month.",
        })
      ).actionData;
    expect(await answer()).toEqual({ intent: `answer:${id}`, error: null });
    expect(await answer()).toEqual({
      intent: `answer:${id}`,
      error: "This question was answered already.",
    });
    expect(scenario.backoffice.prompts(CLIENT, ADMINISTRATION)).toEqual([
      {
        agentName: "books",
        requestId: `firm-answer:${id}`,
        subagent: false,
        prompter: "installation",
        content:
          'Ada Lovelace, of Lovelace & Co, answers the question you asked the accountants, "Why was the March rent booked twice?":\n\nThe second is the deposit; it is booked to 1500 next month.',
        // After the turn under way, and not past a stop someone made.
        whenBusy: "followUp",
        whenPaused: null,
        status: "queued",
      },
    ]);
    expect(await dashboard()).toEqual([]);

    // The firm's own agent is the firm's: it has no one to ask.
    const firmAgent = scenario.agent("installation", {
      organization: "lovelace-co",
      project: "Bookkeeping agent",
    });
    const { administration } = (await ada.navigate(BOOKS)).loaderData["books/layout"] as {
      administration: { id: string };
    };
    expect(
      await firmAgent.call("firm.ask", { administration: administration.id, question: "Anyone?" }),
    ).toMatchObject({ status: 403 });
  });
});

/** The firm's answer to a question about the van, as the conversation reads it. */
function vanAnswer(answer: string) {
  return `Ada Lovelace, of Lovelace & Co, answers the question you asked the accountants, "Is the van a lease?":\n\n${answer}`;
}

/** The administration's assistant asks Ada's firm about the van; how she answers it on the dashboard. */
async function vanQuestion(scenario: BookkeepingScenario) {
  const { ada, firmPath, clientPath } = await scenario.practice();
  await scenario.openAdministration(ada, clientPath, ADMINISTRATION);
  await askPage(ada);
  const assistant = scenario.agent("installation", {
    organization: CLIENT,
    project: ADMINISTRATION,
  });
  const asked = await assistant.call("firm.ask", { question: "Is the van a lease?" });
  const { question: id } = asked.body as { question: string };
  return {
    id,
    dashboard: async () =>
      (
        (await ada.navigate(firmPath)).loaderData["firms/dashboard"] as {
          questions: { answer: unknown }[];
        }
      ).questions,
    // The dashboard is the firm's index page, whose forms post to `?index`; "Send again" posts
    // only the question.
    answer: async (fields: { answer?: string }) =>
      (await ada.submit(`${firmPath}?index`, { question: id, ...fields })).actionData,
    prompts: () =>
      scenario.backoffice.prompts(CLIENT, ADMINISTRATION).map(({ content }) => content),
  };
}

const NOT_SENT = { error: expect.stringMatching(/^The answer was not sent: /u) };

test("an answer whose delivery failed stays kept, and is sent again from the dashboard", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { id, dashboard, answer, prompts } = await vanQuestion(scenario);

    // Backoffice takes the answer, but its reply is lost: the answer is kept, waiting to be sent.
    scenario.backoffice.failNextResponse("pi.prompt.submit");
    expect(await answer({ answer: "Yes, for four years." })).toMatchObject(NOT_SENT);
    const kept = [{ answer: { text: "Yes, for four years.", answeredBy: "Ada Lovelace" } }];
    expect(await dashboard()).toMatchObject(kept);
    // Another answer, from a page opened earlier, does not replace it.
    scenario.backoffice.failNextResponse("pi.prompt.submit");
    expect(await answer({ answer: "No, it was bought." })).toMatchObject(NOT_SENT);
    expect(await dashboard()).toMatchObject(kept);

    expect(await answer({})).toEqual({ intent: `answer:${id}`, error: null });
    expect(prompts()).toEqual([vanAnswer("Yes, for four years.")]);
    expect(await dashboard()).toEqual([]);
    expect(await answer({})).toEqual({
      intent: `answer:${id}`,
      error: "This question was answered already.",
    });
  });
});

test("the conversation gets the firm's first answer, even when another is sent first", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { id, answer, prompts } = await vanQuestion(scenario);

    // The first answer never reaches Backoffice; a later one, from a page opened earlier, sends
    // the first instead.
    scenario.backoffice.failNextRequest("pi.prompt.submit");
    expect(await answer({ answer: "Yes, for four years." })).toMatchObject(NOT_SENT);
    expect(prompts()).toEqual([]);
    expect(await answer({ answer: "No, it was bought." })).toEqual({
      intent: `answer:${id}`,
      error: "An earlier answer, by Ada Lovelace, was sent instead.",
    });
    expect(prompts()).toEqual([vanAnswer("Yes, for four years.")]);
  });
});
