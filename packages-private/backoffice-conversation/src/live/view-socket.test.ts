// @vitest-environment happy-dom

import { afterEach, assert, test, vi } from "vitest";

import type { ConversationView } from "@earendil-works/pi-durable";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { usePiAgentViewSocket } from "./view-socket";

/** The sockets the hook opened, by URL, each delivering what the test sends it. */
class FakeSocket extends EventTarget {
  static opened: FakeSocket[] = [];
  readonly url: string;

  constructor(url: URL) {
    super();
    this.url = url.pathname;
    FakeSocket.opened.push(this);
  }

  send(frame: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  close() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeSocket.opened = [];
});

function viewOf(agent: string): ConversationView {
  // Only a doc named after the agent tells the views apart here.
  return { conversation: null, entries: [], docs: { [agent]: {} } } as unknown as ConversationView;
}

test("another agent's socket shows nothing of the agent before it", async () => {
  vi.stubGlobal("WebSocket", FakeSocket);
  const { result, rerender } = renderHook(
    ({ key }: { key: string }) => usePiAgentViewSocket({ key, url: () => `/${key}` }),
    { initialProps: { key: "a" } },
  );
  await waitFor(() => assert.lengthOf(FakeSocket.opened, 1));
  act(() => {
    FakeSocket.opened[0]!.send({ type: "view", view: viewOf("a") });
  });
  assert.equal(result.current.status, "ready");

  rerender({ key: "b" });
  assert.deepEqual(result.current, { status: "connecting" });
  await waitFor(() => assert.lengthOf(FakeSocket.opened, 2));
  assert.equal(FakeSocket.opened[1]!.url, "/b");
  act(() => {
    FakeSocket.opened[1]!.send({ type: "view", view: viewOf("b") });
  });
  const state = result.current;
  assert.deepEqual(state.status === "ready" ? Object.keys(state.view.docs) : null, ["b"]);
});
