import { assert, expect, test } from "vitest";

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import {
  runBookkeepingScenario,
  type BookkeepingScenario,
  type ScenarioBrowser,
  type ScenarioPage,
} from "../../scenario/bookkeeping-scenario";
import { INVOICE } from "../../scenario/fixtures/invoice";
import type { DocumentView } from "../../workers/books/documents/documents";
import type { BooksOutletContext } from "../books/layout";

const FIRM = "lovelace-co";
/** The project in which Bookkeeping set up the firm's bookkeeping agent. */
const FIRM_AGENT = "Bookkeeping agent";
const CLIENT = "analytical-engines";
const ADMINISTRATION = "Analytical Engines";
const BOOKS = "/w/analytical-engines/a/analytical-engines";
const YEAR = new Date().getUTCFullYear();

type Books = BooksOutletContext["books"];
type Upload = { name: string; type: string; bytes: Uint8Array<ArrayBuffer> };

/** Ada's practice keeps the books of Analytical Engines, which she has just opened. */
async function openBooks(scenario: BookkeepingScenario) {
  const practice = await scenario.practice();
  await scenario.openAdministration(practice.ada, practice.clientPath, ADMINISTRATION);
  return practice;
}

function pdf(text: string): Upload {
  return {
    name: "invoice.pdf",
    type: "application/pdf",
    bytes: new TextEncoder().encode(`%PDF-1.7\n${text}\n%%EOF\n`),
  };
}

/** The ID the documents page chose for its upload form. */
async function uploadFormId(browser: ScenarioBrowser): Promise<string> {
  const page = await browser.navigate(`${BOOKS}/documents`);
  return (page.loaderData["documents/documents"] as { documentId: string }).documentId;
}

async function upload(browser: ScenarioBrowser, file: Upload, documentId?: string) {
  return await browser.upload(
    `${BOOKS}/documents`,
    { intent: "upload", documentId: documentId ?? (await uploadFormId(browser)) },
    file,
  );
}

/** Uploads a file and returns the ID of the document it opened. */
async function uploaded(browser: ScenarioBrowser, file: Upload): Promise<string> {
  const page = await upload(browser, file);
  const id = new RegExp(`^${BOOKS}/documents/([^/?]+)$`, "u").exec(page.path)?.[1];
  assert(id, `The upload did not open its document: ${JSON.stringify(page)}`);
  return id;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
}

/** Reverses an entry from its page, on the date given. */
async function reverse(browser: ScenarioBrowser, entry: string, postingDate: string) {
  return await browser.submit(`${BOOKS}/entries/${entry}`, {
    intent: "reverse",
    resultIntent: "reverse",
    postingDate,
  });
}

async function readDocument(browser: ScenarioBrowser, id: string): Promise<DocumentView> {
  const page = await browser.navigate(`${BOOKS}/documents/${id}`);
  return (page.loaderData["documents/document"] as { document: DocumentView }).document;
}

async function listDocuments(browser: ScenarioBrowser): Promise<DocumentView[]> {
  const page = await browser.navigate(`${BOOKS}/documents`);
  return (page.loaderData["documents/documents"] as { documents: { items: DocumentView[] } })
    .documents.items;
}

async function readBooks(browser: ScenarioBrowser) {
  const page = await browser.navigate(`${BOOKS}/settings`);
  return page.loaderData["books/layout"] as { administration: { id: string }; books: Books };
}

function find<T extends { code: string; id: string }>(rows: T[], code: string): T {
  const row = rows.find((candidate) => candidate.code === code);
  assert(row, `No ${code}.`);
  return row;
}

/** The new-entry form booking a purchase of `amount` paid from the bank, in `journal`. */
function purchaseForm(books: Books, journal: string, amount: string, date: string) {
  const line = (row: number, account: string, side: "debit" | "credit") => ({
    [`lines.${row}.accountId`]: find(books.accounts, account).id,
    [`lines.${row}.description`]: "",
    [`lines.${row}.debit`]: side === "debit" ? amount : "",
    [`lines.${row}.credit`]: side === "credit" ? amount : "",
    [`lines.${row}.currency`]: books.functionalCurrency,
    [`lines.${row}.functionalAmount`]: "",
    [`lines.${row}.partyAccountId`]: "",
  });
  return {
    journalId: find(books.journals, journal).id,
    postingDate: date,
    reference: "",
    description: "Difference engine parts",
    ...line(0, "4000", "debit"),
    ...line(1, "1000", "credit"),
  };
}

async function book(
  browser: ScenarioBrowser,
  id: string,
  form: Record<string, string>,
): Promise<ScenarioPage> {
  return await browser.submit(`${BOOKS}/entries/new?document=${id}`, { ...form, documentId: id });
}

test("a member uploads an invoice, books it from its page, and the entry links back to it", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, grace } = await openBooks(scenario);
    const invoice = { ...pdf("Babbage Instruments, invoice 7"), name: "babbage invoice #7.pdf" };
    const id = await uploaded(ada, invoice);

    expect(await readDocument(ada, id)).toMatchObject({
      filename: "babbage invoice #7.pdf",
      mediaType: "application/pdf",
      sizeBytes: invoice.bytes.byteLength,
      uploadedBy: "Ada Lovelace",
      source: null,
      state: { status: "to-book" },
    });
    // The file lives in the administration's Backoffice project, where its agents work.
    expect(scenario.backoffice.workspacePaths(CLIENT, ADMINISTRATION)).toEqual([
      `/workspace/documents/${id}/${await sha256(invoice.bytes)}/babbage-invoice-7.pdf`,
    ]);
    const file = await ada.download(`${BOOKS}/documents/${id}/file`);
    assert(file.status === 200);
    expect(Object.fromEntries(file.headers)).toMatchObject({
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(invoice.bytes);
    // Grace operates Bookkeeping but is no member of the client.
    assert((await grace.download(`${BOOKS}/documents/${id}/file`)).status === 404);

    const { books } = await readBooks(ada);
    const booked = await book(ada, id, {
      ...purchaseForm(books, "PUR", "121.00", `${YEAR}-03-10`),
      documentDate: `${YEAR}-03-01`,
    });
    expect(booked.path).toBe(`${BOOKS}/documents/${id}`);
    const document = await readDocument(ada, id);
    expect(document).toMatchObject({
      source: {
        id,
        kind: "document",
        documentDate: `${YEAR}-03-01`,
        description: "Difference engine parts",
        entries: [{ entryNumber: 1, postingDate: `${YEAR}-03-10`, reversedByEntryId: null }],
      },
    });
    expect(document.state).toEqual({ status: "booked", entryId: document.source?.entries[0].id });
    const entry = await ada.navigate(`${BOOKS}/entries/PUR/1`);
    expect(entry.loaderData["books/entry"]).toMatchObject({
      document: { id, filename: "babbage invoice #7.pdf" },
    });
    expect(await listDocuments(ada)).toMatchObject([{ id, state: { status: "booked" } }]);
  });
});

test("a document is booked once; reversing its entry lets it be booked again, and a dismissed one is not booked", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    const { administration, books } = await readBooks(ada);
    const id = await uploaded(ada, pdf("Babbage Instruments, invoice 8"));
    const purchase = purchaseForm(books, "PUR", "50.00", `${YEAR}-04-02`);
    await book(ada, id, { ...purchase, documentDate: `${YEAR}-04-01` });

    // Its page answers instead, and nothing more is posted.
    expect((await book(ada, id, { ...purchase, documentDate: `${YEAR}-04-01` })).path).toBe(
      `${BOOKS}/documents/${id}`,
    );
    expect(
      await ada.submit(`${BOOKS}/documents/${id}`, { intent: "dismiss", resultIntent: "dismiss" }),
    ).toMatchObject({
      actionData: { error: "This document is booked. Reverse its entry first." },
    });

    await reverse(ada, "PUR/1", `${YEAR}-04-20`);
    expect(await readDocument(ada, id)).toMatchObject({
      state: { status: "to-book" },
      source: { entries: [{ entryNumber: 1 }, { entryNumber: 2 }] },
    });
    // Booked again in another journal; the document keeps the date it was first booked with.
    await book(ada, id, purchaseForm(books, "GEN", "55.00", `${YEAR}-04-21`));
    const rebooked = await readDocument(ada, id);
    expect(rebooked.source).toMatchObject({
      documentDate: `${YEAR}-04-01`,
      entries: [{ entryNumber: 1 }, { entryNumber: 2 }, { entryNumber: 1 }],
    });
    expect(rebooked.state).toEqual({ status: "booked", entryId: rebooked.source?.entries[2].id });

    const duplicate = await uploaded(ada, pdf("Babbage Instruments, invoice 8, again"));
    expect(
      await ada.submit(`${BOOKS}/documents/${duplicate}`, {
        intent: "dismiss",
        resultIntent: "dismiss",
      }),
    ).toMatchObject({ actionData: { error: null } });
    expect((await readDocument(ada, duplicate)).state).toMatchObject({
      status: "dismissed",
      by: "Ada Lovelace",
    });
    expect((await book(ada, duplicate, purchase)).path).toBe(`${BOOKS}/documents/${duplicate}`);
    // A booking that lost the race with dismissing posts nothing: the document and its entry are
    // written in one transaction.
    const outcome = await scenario.env.BOOKS.getByName(administration.id).bookDocument({
      documentId: duplicate,
      source: { type: "new", documentDate: `${YEAR}-04-01`, description: "Late" },
      entry: {
        journalId: find(books.journals, "PUR").id,
        postingDate: `${YEAR}-04-22`,
        description: "Late",
        reference: null,
        postedBy: "Ada Lovelace",
        lines: [
          {
            accountId: find(books.accounts, "4000").id,
            side: "debit",
            currency: "EUR",
            amountMinor: 100n,
            functionalAmountMinor: 100n,
            description: "",
            dimensionValueIds: [],
            openItem: null,
          },
          {
            accountId: find(books.accounts, "1000").id,
            side: "credit",
            currency: "EUR",
            amountMinor: 100n,
            functionalAmountMinor: 100n,
            description: "",
            dimensionValueIds: [],
            openItem: null,
          },
        ],
      },
    });
    expect(outcome).toMatchObject({ ok: false, code: "DOCUMENT_DISMISSED" });
    assert(find((await readBooks(ada)).books.journals, "PUR").lastEntryNumber === 2);
    expect((await readDocument(ada, duplicate)).source).toBeNull();
  });
});

test("a file changed or deleted in Backoffice is no longer shown as the document", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    const id = await uploaded(ada, pdf("Babbage Instruments, invoice 9"));
    const path = (await readDocument(ada, id)).storageKey;

    scenario.backoffice.admin.replaceWorkspaceFile(
      CLIENT,
      ADMINISTRATION,
      path,
      pdf("Babbage Instruments, invoice 9, for twice as much").bytes,
    );
    const changed = await ada.download(`${BOOKS}/documents/${id}/file`);
    assert(changed.status === 409);
    assert(
      (await changed.text()) ===
        "This document's file was changed in Backoffice after it was uploaded, so Bookkeeping no longer shows it.",
    );

    scenario.backoffice.admin.replaceWorkspaceFile(CLIENT, ADMINISTRATION, path, null);
    const deleted = await ada.download(`${BOOKS}/documents/${id}/file`);
    assert(deleted.status === 404);
    assert((await deleted.text()) === "This document's file is no longer in Backoffice.");
  });
});

test("only scans and photos are uploaded, and an upload that failed is finished by uploading again", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    const markup = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect(
      await upload(ada, { name: "invoice.pdf", type: "application/pdf", bytes: markup }),
    ).toMatchObject({
      actionData: { error: "Upload a PDF, or a PNG, JPEG, or WebP image." },
    });
    const large = new Uint8Array(1_900_001);
    large.set(pdf("").bytes);
    expect(await upload(ada, { ...pdf(""), bytes: large })).toMatchObject({
      actionData: { error: "Upload files of at most 1.9 MB." },
    });
    expect(scenario.backoffice.workspacePaths(CLIENT, ADMINISTRATION)).toEqual([]);
    expect(await listDocuments(ada)).toEqual([]);

    // What a file is comes from its bytes, not the type the browser sends.
    const photo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const receipt = await uploaded(ada, {
      name: "receipt.png",
      type: "application/octet-stream",
      bytes: photo,
    });
    expect(await readDocument(ada, receipt)).toMatchObject({ mediaType: "image/png" });

    const invoice = pdf("Babbage Instruments, invoice 10");
    const documentId = await uploadFormId(ada);
    scenario.backoffice.setReachable(false);
    expect(await upload(ada, invoice, documentId)).toMatchObject({ status: 503 });
    scenario.backoffice.setReachable(true);
    expect((await upload(ada, invoice, documentId)).path).toBe(`${BOOKS}/documents/${documentId}`);
    // The form's ID names this document now: another file sent with it changes nothing.
    expect(await upload(ada, pdf("Something else"), documentId)).toMatchObject({
      actionData: { error: "Another file was uploaded with this form. Upload it again." },
    });
    expect((await listDocuments(ada)).map((document) => document.id).sort()).toEqual(
      [receipt, documentId].sort(),
    );
    expect(
      scenario.backoffice.workspaceFile(
        CLIENT,
        ADMINISTRATION,
        (await readDocument(ada, documentId)).storageKey,
      ),
    ).toEqual(invoice.bytes);
  });
});

test("reversing a reversal books the document again, so it is refused unless the document is to book", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    const { books } = await readBooks(ada);
    const id = await uploaded(ada, pdf("Babbage Instruments, invoice 11"));
    await book(ada, id, {
      ...purchaseForm(books, "PUR", "80.00", `${YEAR}-05-02`),
      documentDate: `${YEAR}-05-01`,
    });
    await reverse(ada, "PUR/1", `${YEAR}-05-03`);
    await book(ada, id, purchaseForm(books, "GEN", "80.00", `${YEAR}-05-04`));

    // Reversing PUR 2 would put PUR 1 back in effect beside GEN 1.
    expect(await reverse(ada, "PUR/2", `${YEAR}-05-05`)).toMatchObject({
      actionData: { error: "This document is booked. Reverse its entry first." },
    });
    await reverse(ada, "GEN/1", `${YEAR}-05-05`);
    expect((await readDocument(ada, id)).state).toEqual({ status: "to-book" });
    // Undoing PUR 1's reversal books the document with PUR 1's lines, in PUR 3.
    expect((await reverse(ada, "PUR/2", `${YEAR}-05-06`)).path).toBe(`${BOOKS}/entries/PUR/3`);
    const restored = await readDocument(ada, id);
    expect(restored.state).toEqual({ status: "booked", entryId: restored.source?.entries[4].id });
    expect((await book(ada, id, purchaseForm(books, "GEN", "80.00", `${YEAR}-05-07`))).path).toBe(
      `${BOOKS}/documents/${id}`,
    );
    expect(
      await ada.submit(`${BOOKS}/documents/${id}`, { intent: "dismiss", resultIntent: "dismiss" }),
    ).toMatchObject({
      actionData: { error: "This document is booked. Reverse its entry first." },
    });

    await reverse(ada, "PUR/3", `${YEAR}-05-08`);
    await ada.submit(`${BOOKS}/documents/${id}`, { intent: "dismiss", resultIntent: "dismiss" });
    expect(await reverse(ada, "PUR/4", `${YEAR}-05-09`)).toMatchObject({
      actionData: { error: "This document was dismissed." },
    });
    const journals = (await readBooks(ada)).books.journals;
    expect([find(journals, "PUR"), find(journals, "GEN")]).toMatchObject([
      { lastEntryNumber: 4 },
      { lastEntryNumber: 2 },
    ]);
  });
});

test("files sent at once with one upload form record one document, which keeps its own file", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    const { administration } = await readBooks(ada);
    const invoice = pdf("Babbage Instruments, invoice 12");
    const same = await uploadFormId(ada);
    const twice = await Promise.all([upload(ada, invoice, same), upload(ada, invoice, same)]);
    expect(twice.map((page) => page.path)).toEqual([
      `${BOOKS}/documents/${same}`,
      `${BOOKS}/documents/${same}`,
    ]);
    // Requests can also both find the document unrecorded and record it at the same moment.
    const recorded = await readDocument(ada, same);
    const books = scenario.env.BOOKS.getByName(administration.id);
    const again = {
      id: await uploadFormId(ada),
      filename: recorded.filename,
      mediaType: recorded.mediaType,
      sizeBytes: recorded.sizeBytes,
      sha256: recorded.sha256,
      storageKey: recorded.storageKey,
      uploadedBy: recorded.uploadedBy,
    };
    expect(
      await Promise.all([books.recordDocument(again), books.recordDocument(again)]),
    ).toMatchObject([{ ok: true }, { ok: true }]);

    const other = await uploadFormId(ada);
    const raced = await Promise.all([
      upload(ada, invoice, other),
      upload(ada, pdf("Babbage Instruments, invoice 12, for twice as much"), other),
    ]);
    expect(raced.filter((page) => page.path === `${BOOKS}/documents/${other}`)).toHaveLength(1);
    const document = await readDocument(ada, other);
    const file = await ada.download(`${BOOKS}/documents/${other}/file`);
    assert(file.status === 200);
    expect(await sha256(new Uint8Array(await file.arrayBuffer()))).toBe(document.sha256);
    expect((await listDocuments(ada)).map((listed) => listed.id).sort()).toEqual(
      [same, again.id, other].sort(),
    );
  });
});

test("an upload body larger than any document is refused without being read whole", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    expect(
      await ada.post(`${BOOKS}/documents`, endless, "multipart/form-data; boundary=unending"),
    ).toMatchObject({ actionData: { error: "Upload files of at most 1.9 MB." } });
    expect(sent).toBeLessThan(2 * 1024 * 1024);
    expect(await listDocuments(ada)).toEqual([]);
  });
});

/** The document page's view of how far the bookkeeping agent got with its request. */
async function readProgress(browser: ScenarioBrowser, id: string) {
  const page = await browser.navigate(`${BOOKS}/documents/${id}`);
  return (page.loaderData["documents/document"] as { progress: unknown }).progress;
}

/** A line of a proposed entry, as agents pass it: accounts by code and amounts as decimals. */
function proposedLine(account: string, side: "debit" | "credit", amount: string) {
  return {
    account,
    side,
    amount,
    currency: null,
    functionalAmount: null,
    description: "",
    party: null,
    dueDate: null,
    dimensions: {},
  };
}

/** Babbage Instruments' invoice, a PDF as people upload them; see `scenario/fixtures`. */
const invoiceFixture: Upload = {
  name: `${INVOICE.number}.pdf`,
  type: "application/pdf",
  bytes: new Uint8Array(
    readFileSync(new URL("../../scenario/fixtures/invoice.pdf", import.meta.url)),
  ),
};

const INVOICE_TOTAL = (INVOICE.totalCents / 100).toFixed(2);

/**
 * The firm's bookkeeping agent, which Bookkeeping prompts as its installation in the firm's agent
 * project; its calls name the administration whose books they keep.
 */
async function firmAgent(scenario: BookkeepingScenario, browser: ScenarioBrowser) {
  const { administration } = await readBooks(browser);
  const agent = scenario.agent("installation", { organization: FIRM, project: FIRM_AGENT });
  return {
    administration,
    call: async (actionId: string, input: Record<string, unknown>) =>
      await agent.call(actionId, { administration: administration.id, ...input }),
  };
}

/** The fixture invoice's entry, as the agent proposes it, with these amounts. */
function proposal(id: string, debit: string, credit: string) {
  return {
    document: id,
    documentDate: INVOICE.invoiceDate,
    entry: {
      journal: "PUR",
      postingDate: `${YEAR}-03-02`,
      reference: INVOICE.number,
      description: `${INVOICE.supplier.name}, invoice ${INVOICE.number}`,
      lines: [proposedLine("4000", "debit", debit), proposedLine("1000", "credit", credit)],
    },
    note: "A purchase of engine parts, paid from the bank as earlier ones were.",
  };
}

test("uploading asks the bookkeeping agent, whose proposed entry a member reviews and books", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    const invoice = invoiceFixture;
    // Sending the upload twice at once, as a double click does, asks once.
    const id = await uploadFormId(ada);
    await Promise.all([upload(ada, invoice, id), upload(ada, invoice, id)]);

    // The agent lives with the firm, so the skills the firm gives it stay out of the client's
    // workspace; the document's folder is shared with it while it is asked.
    expect(scenario.backoffice.agents(CLIENT, ADMINISTRATION)).toEqual([]);
    expect(scenario.backoffice.agents(FIRM, FIRM_AGENT)).toMatchObject([
      {
        agentName: "bookkeeper",
        permissions: ["upload.read", "models.extract", "integrations.read", "integrations.execute"],
      },
    ]);
    const [prompt, ...more] = scenario.backoffice.prompts(FIRM, FIRM_AGENT);
    expect(more).toEqual([]);
    const agent = await firmAgent(scenario, ada);
    // Each document gets a subagent of its own, so documents are read side by side. The firm's
    // agent answers all its clients' administrations, so the request names the administration.
    expect(prompt).toMatchObject({
      agentName: "bookkeeper",
      requestId: `document:${agent.administration.id}:${id}:upload`,
      subagent: true,
      prompter: "installation",
      status: "queued",
    });
    const folder = `/workspace/documents/${id}/${await sha256(invoice.bytes)}/`;
    const [mount, ...otherMounts] = scenario.backoffice.mountedShares(FIRM, FIRM_AGENT);
    expect(otherMounts).toEqual([]);
    expect(mount).toEqual({
      name: expect.stringMatching(/^document-[0-9a-f]{40}$/u),
      path: folder,
    });
    const sharedFile = `/shared/${mount!.name}/${INVOICE.number}.pdf`;
    expect(prompt.content).toContain(agent.administration.id);
    expect(prompt.content).toContain(sharedFile);
    expect(await readDocument(ada, id)).toMatchObject({
      review: { status: "requested", requestId: prompt.requestId, by: "Ada Lovelace" },
    });
    expect(await readProgress(ada, id)).toEqual({ requestId: prompt.requestId, status: "queued" });
    scenario.backoffice.settlePrompt(prompt.requestId, { status: "running" });
    expect(await readProgress(ada, id)).toEqual({ requestId: prompt.requestId, status: "running" });

    // Bookkeeping prompts the agent as its installation, so its calls change nothing but reviews,
    // whatever a document tells it.
    expect(
      await agent.call("entries.post", proposal(id, INVOICE_TOTAL, INVOICE_TOTAL).entry),
    ).toEqual({
      status: 403,
      body: {
        message:
          "A firm's bookkeeping agent reads its clients' books and proposes documents' entries; people change them, in their client's project.",
      },
    });
    expect(await agent.call("documents.get", { document: id })).toEqual({
      status: 200,
      body: expect.objectContaining({
        path: sharedFile,
        mediaType: "application/pdf",
        status: "to-book",
        bookedIn: null,
        review: "requested",
      }),
    });
    expect(await agent.call("documents.propose", proposal(id, INVOICE_TOTAL, "776.00"))).toEqual({
      status: 422,
      body: {
        message: `The entry does not balance: debits ${INVOICE_TOTAL} and credits 776.00 EUR.`,
      },
    });
    // The agent answers, and its turn ends, while the page asks how far it got.
    scenario.backoffice.beforeNextAnswer("pi.prompt.get", async () => {
      expect(
        await agent.call("documents.propose", proposal(id, INVOICE_TOTAL, INVOICE_TOTAL)),
      ).toEqual({
        status: 200,
        body: { document: id, review: "proposed" },
      });
      scenario.backoffice.settlePrompt(prompt.requestId, { status: "completed", answer: null });
    });
    const answered = await ada.navigate(`${BOOKS}/documents/${id}`);
    expect(answered.loaderData["documents/document"]).toMatchObject({
      document: { review: { status: "proposed" } },
      progress: null,
    });
    // Having answered, the agent no longer reads the document's file.
    expect(scenario.backoffice.mountedShares(FIRM, FIRM_AGENT)).toEqual([]);
    // Uploading again does not ask again, nor undo the answer.
    await upload(ada, invoice, id);
    expect(scenario.backoffice.prompts(FIRM, FIRM_AGENT)).toHaveLength(1);

    const { books } = await readBooks(ada);
    const document = await readDocument(ada, id);
    expect(document.review).toEqual({
      status: "proposed",
      entry: {
        journalId: find(books.journals, "PUR").id,
        postingDate: `${YEAR}-03-02`,
        documentDate: INVOICE.invoiceDate,
        reference: INVOICE.number,
        description: `${INVOICE.supplier.name}, invoice ${INVOICE.number}`,
        lines: [
          expect.objectContaining({ accountId: find(books.accounts, "4000").id, side: "debit" }),
          expect.objectContaining({ accountId: find(books.accounts, "1000").id, side: "credit" }),
        ],
      },
      note: "A purchase of engine parts, paid from the bank as earlier ones were.",
      by: "the bookkeeping agent",
      at: expect.any(String),
    });
    expect(await readProgress(ada, id)).toBeNull();
    // The new-entry form starts from the proposal, and Ada books it as proposed.
    const form = await ada.navigate(`${BOOKS}/entries/new?document=${id}`);
    expect(form.loaderData["books/new-entry"]).toMatchObject({
      document: { review: { status: "proposed" } },
    });
    assert(document.review?.status === "proposed");
    const { entry } = document.review;
    const booked = await book(ada, id, {
      journalId: entry.journalId,
      postingDate: entry.postingDate,
      documentDate: entry.documentDate,
      reference: entry.reference ?? "",
      description: entry.description,
      ...Object.fromEntries(
        entry.lines.flatMap((line, row) => [
          [`lines.${row}.accountId`, line.accountId],
          [`lines.${row}.description`, line.description],
          [`lines.${row}.${line.side}`, line.amount],
          [`lines.${row}.currency`, line.currency],
          [`lines.${row}.partyAccountId`, line.partyAccountId ?? ""],
        ]),
      ),
    });
    expect(booked.path).toBe(`${BOOKS}/documents/${id}`);
    expect(await readDocument(ada, id)).toMatchObject({
      state: { status: "booked" },
      source: { documentDate: INVOICE.invoiceDate, entries: [{ entryNumber: 1 }] },
    });
    // A booked document takes no more proposals.
    expect(
      await agent.call("documents.propose", proposal(id, INVOICE_TOTAL, INVOICE_TOTAL)),
    ).toEqual({
      status: 422,
      body: { message: "This document is booked. Reverse its entry first." },
    });
  });
});

test("the same document ID in two administrations reaches the firm's agent as two documents", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada, clientPath } = await openBooks(scenario);
    const other = await scenario.openAdministration(ada, clientPath, "Difference Engines");
    // The page chooses a document's ID, which is unique only in its administration.
    const id = await uploadFormId(ada);
    const first = pdf("Babbage Instruments, invoice 11");
    const second = pdf("Babbage Instruments, invoice 12");
    await upload(ada, first, id);
    await ada.upload(`${other}/documents`, { intent: "upload", documentId: id }, second);

    const administrationOf = async (books: string) =>
      (
        (await ada.navigate(`${books}/settings`)).loaderData["books/layout"] as {
          administration: { id: string };
        }
      ).administration.id;
    const expected = [
      {
        administration: await administrationOf(BOOKS),
        folder: `/workspace/documents/${id}/${await sha256(first.bytes)}/`,
      },
      {
        administration: await administrationOf(other),
        folder: `/workspace/documents/${id}/${await sha256(second.bytes)}/`,
      },
    ];
    // Each prompt names its administration and the mount of that administration's file.
    const mounts = scenario.backoffice.mountedShares(FIRM, FIRM_AGENT);
    expect(
      scenario.backoffice.prompts(FIRM, FIRM_AGENT).map((prompt) => ({
        administration: expected.find(({ administration }) =>
          prompt.content.includes(administration),
        )?.administration,
        folder: mounts.find(({ name }) => prompt.content.includes(`/shared/${name}/`))?.path,
      })),
    ).toEqual(expected);
  });
});

test("a request the agent never received, or failed, is asked again from the document's page", async () => {
  await runBookkeepingScenario(async (scenario) => {
    const { ada } = await openBooks(scenario);
    // Backoffice could not set the agent up, so it was never asked; the page says so.
    scenario.backoffice.failNextRequest("pi.agent.create");
    const id = await uploaded(ada, pdf("Babbage Instruments, invoice 10"));
    expect(scenario.backoffice.agents(FIRM, FIRM_AGENT)).toEqual([]);
    expect(scenario.backoffice.prompts(FIRM, FIRM_AGENT)).toEqual([]);
    const { review } = await readDocument(ada, id);
    assert(review?.status === "requested");
    expect(await readProgress(ada, id)).toEqual({ status: "lost" });
    // While Backoffice cannot be reached, the page shows the document and that it cannot say.
    scenario.backoffice.setReachable(false);
    expect(await readProgress(ada, id)).toEqual({
      status: "unknown",
      message: "Backoffice could not be reached.",
    });
    expect(await ada.submit(`${BOOKS}/documents/${id}`, { intent: "ask" })).toMatchObject({
      actionData: {
        intent: "ask",
        error: "Backoffice did not ask the agent: Backoffice could not be reached.",
      },
    });
    scenario.backoffice.setReachable(true);

    const ask = { intent: "ask" };
    expect(await ada.submit(`${BOOKS}/documents/${id}`, ask)).toMatchObject({
      actionData: { intent: "ask", error: null },
    });
    const [first, ...more] = scenario.backoffice.prompts(FIRM, FIRM_AGENT);
    expect(more).toEqual([]);
    expect(first.requestId).not.toBe(review.requestId);
    scenario.backoffice.settlePrompt(first.requestId, {
      status: "failed",
      reason: "The model is unavailable.",
    });
    expect(await readProgress(ada, id)).toEqual({
      requestId: first.requestId,
      status: "failed",
      reason: "The model is unavailable.",
    });

    await ada.submit(`${BOOKS}/documents/${id}`, ask);
    const second = scenario.backoffice.prompts(FIRM, FIRM_AGENT).at(-1)!;
    expect(second.requestId).not.toBe(first.requestId);
    // The agent stays as Bookkeeping defined it the first time, and asking again shares the
    // document once.
    expect(scenario.backoffice.agents(FIRM, FIRM_AGENT)).toHaveLength(1);
    expect(scenario.backoffice.standingShares(CLIENT, ADMINISTRATION)).toHaveLength(1);
    const [mount, ...otherMounts] = scenario.backoffice.mountedShares(FIRM, FIRM_AGENT);
    expect(otherMounts).toEqual([]);
    const agent = await firmAgent(scenario, ada);
    expect(
      await agent.call("documents.decline", { document: id, reason: "This is a price list." }),
    ).toEqual({ status: 200, body: { document: id, review: "declined" } });
    // Having answered, the agent no longer reads the document's file.
    expect(scenario.backoffice.mountedShares(FIRM, FIRM_AGENT)).toEqual([]);
    expect(await readDocument(ada, id)).toMatchObject({
      review: { status: "declined", reason: "This is a price list." },
    });
    // Asking after the answer shares the file again, under the name the revoked share held.
    await ada.submit(`${BOOKS}/documents/${id}`, ask);
    expect(scenario.backoffice.mountedShares(FIRM, FIRM_AGENT)).toEqual([
      { name: mount!.name, path: expect.stringMatching(`^/workspace/documents/${id}/`) },
    ]);

    // A dismissed document is not proposed for, nor asked about, and its file is no longer
    // shared once its page shows it dismissed.
    await ada.submit(`${BOOKS}/documents/${id}`, { intent: "dismiss", resultIntent: "dismiss" });
    await readDocument(ada, id);
    expect(scenario.backoffice.mountedShares(FIRM, FIRM_AGENT)).toEqual([]);
    expect(await agent.call("documents.propose", proposal(id, "1.00", "1.00"))).toEqual({
      status: 422,
      body: { message: "This document was dismissed." },
    });
    expect(await ada.submit(`${BOOKS}/documents/${id}`, ask)).toMatchObject({
      actionData: { intent: "ask", error: "This document was dismissed." },
    });
    expect(scenario.backoffice.prompts(FIRM, FIRM_AGENT)).toHaveLength(3);
  });
});
