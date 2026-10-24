import { connectLofiZql, type LofiZqlResult } from "@fragno-dev/lofi/zql";

import { uploadSchema } from "../../../packages/fragment-upload/src/schema";
import { ZQL_ERRORS_CHANNEL } from "./zql-errors";

type ViewRun = {
  updates: number;
  firstDataMs: number | null;
  lastUpdateMs: number | null;
  result: LofiZqlResult<unknown>;
};

declare global {
  interface Window {
    /** Each view's updates and latest result, for reading from the browser console. */
    lofiZqlViews: Record<string, ViewRun>;
  }
}

const startedAt = performance.now();
const worker = new Worker(new URL("./zql.worker.ts", import.meta.url), { type: "module" });
// The page replays an Upload outbox, whose text documents reference their files.
const upload = (
  await connectLofiZql({ port: worker, schemas: [{ schema: uploadSchema }] })
).forSchema(uploadSchema);

const stores = {
  latestReadyFiles: upload.store(
    upload.query.file.where("status", "ready").orderBy("createdAt", "desc").limit(10),
  ),
  latestDocumentsWithFile: upload.store(
    upload.query.file_text_document.related("file").orderBy("indexedAt", "desc").limit(5),
  ),
  termsInDocumentsOfJavaScriptFiles: upload.store(
    upload.query.file_text_term
      .where("term", "function")
      .whereExists("document", (document) =>
        document.whereExists("file", (file) => file.where("contentType", "text/javascript")),
      )
      .related("document", (document) => document.related("file"))
      .limit(5),
  ),
};

window.lofiZqlViews = {};
for (const [name, store] of Object.entries(stores)) {
  const run: ViewRun = {
    updates: 0,
    firstDataMs: null,
    lastUpdateMs: null,
    result: { status: "loading" },
  };
  window.lofiZqlViews[name] = run;
  store.subscribe((result) => {
    run.result = result;
    if (result.status === "ready") {
      run.updates += 1;
      run.lastUpdateMs = Math.round(performance.now() - startedAt);
      run.firstDataMs ??= run.lastUpdateMs;
    }
    render();
  });
}

const errors = new BroadcastChannel(ZQL_ERRORS_CHANNEL);
errors.onmessage = (event: MessageEvent<string>) => {
  element("errors").textContent += `${event.data}\n`;
};

function render(): void {
  element("views").innerHTML = Object.entries(window.lofiZqlViews)
    .map(([name, run]) => {
      const rows = run.result.status === "ready" ? run.result.data : null;
      return `<h2>${name}</h2>
        <p>${run.result.status}: ${run.updates} updates, first data at ${run.firstDataMs ?? "–"} ms, last at ${run.lastUpdateMs ?? "–"} ms${
          run.result.status === "error" ? `, ${run.result.message}` : ""
        }</p>
        <pre>${escapeHtml(JSON.stringify(rows, null, 2))}</pre>`;
    })
    .join("");
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing #${id}`);
  }
  return found;
}
