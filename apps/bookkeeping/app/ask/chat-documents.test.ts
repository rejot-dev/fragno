// @vitest-environment happy-dom

import { afterEach, assert, test, vi } from "vitest";

import { act, cleanup, renderHook } from "@testing-library/react";

import { useChatDocuments } from "./chat-documents";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Holds each upload until the test answers it, and names the files it was given. */
function holdUploads() {
  const uploads: { name: string; answer: () => void }[] = [];
  vi.stubGlobal("fetch", async (_path: string, init: { body: FormData }) => {
    const file = init.body.get("file");
    assert.instanceOf(file, File);
    await new Promise<void>((resolve) => {
      uploads.push({ name: file.name, answer: resolve });
    });
    return Response.json({ error: null });
  });
  return uploads;
}

test("a file added while a message's files upload stays for the next message", async () => {
  const uploads = holdUploads();
  const { result } = renderHook(() => useChatDocuments("/ask/documents"));
  act(() => {
    result.current.add([new File(["a"], "first.pdf", { type: "application/pdf" })]);
  });

  let sent!: Promise<{ documents: string[]; failed: string[] }>;
  act(() => {
    sent = result.current.take();
  });
  act(() => {
    result.current.add([new File(["b"], "second.pdf", { type: "application/pdf" })]);
  });
  assert.deepEqual(
    result.current.items.map(({ file, upload }) => [file.name, upload.kind]),
    [
      ["first.pdf", "uploading"],
      ["second.pdf", "uploaded"],
    ],
  );

  await act(async () => {
    uploads[0]!.answer();
    await sent;
  });
  assert.deepEqual(
    uploads.map(({ name }) => name),
    ["first.pdf"],
  );
  assert.deepEqual(
    result.current.items.map(({ file }) => file.name),
    ["second.pdf"],
  );
  assert.isFalse(result.current.sending);

  let next!: Promise<{ documents: string[]; failed: string[] }>;
  act(() => {
    next = result.current.take();
  });
  await act(async () => {
    uploads[1]!.answer();
    assert.lengthOf((await next).documents, 1);
  });
  assert.deepEqual(
    uploads.map(({ name }) => name),
    ["first.pdf", "second.pdf"],
  );
  assert.deepEqual(result.current.items, []);
});
