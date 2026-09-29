import { expect, test, assert } from "vitest";

import { CODEMODE_LIMITS } from "../codemode-limits";
import { CodemodePeer } from "./codemode-peer";
import type { CodemodeMessage } from "./codemode-protocol";
import { encodeCodemodeFrame } from "./codemode-values";

const start: CodemodeMessage = {
  type: "start",
  protocolVersion: 1,
  executionId: "22da3930-47ce-4a76-9429-3779a9a229a6",
  activation: { kind: "immediate", code: "42", dependencies: {}, providers: [], timeoutMs: 1000 },
};

function createPeer() {
  const frames: string[] = [];
  const errors: Error[] = [];
  const peer = new CodemodePeer({
    role: "bridge",
    send: (text) => {
      frames.push(text);
    },
    bufferedBytes: () => 0,
    close() {},
    onClose: (error) => {
      errors.push(error);
    },
    control() {},
    handle: async () => undefined,
  });
  peer.receive(encodeCodemodeFrame(start));
  return { peer, frames, errors };
}

test("disconnect rejects every pending call and forbids later capabilities", async () => {
  const { peer } = createPeer();
  const call = {
    operation: "provider.call" as const,
    provider: "store",
    tool: "get",
    argsJson: "[]",
  };
  const pending = Promise.allSettled([peer.call(call), peer.call(call)]);
  peer.close();
  expect(await pending).toEqual([
    expect.objectContaining({ status: "rejected" }),
    expect.objectContaining({ status: "rejected" }),
  ]);
  await expect(peer.call(call)).rejects.toThrow("CODEMODE_CONNECTION_NOT_RUNNING");
});

test("unknown results, wrong-role calls, repeated start, and stale versions fail closed", () => {
  const invalid = [
    { type: "return", id: 999, result: { status: "ok", value: 1 } },
    {
      type: "call",
      id: 1,
      call: { operation: "provider.call", provider: "store", tool: "get", argsJson: "[]" },
    },
    start,
    { ...start, protocolVersion: 2 },
  ];
  for (const message of invalid) {
    const { peer, errors } = createPeer();
    peer.receive(encodeCodemodeFrame(message));
    assert(peer.closed);
    expect(errors).toHaveLength(1);
    peer.close();
    expect(errors).toHaveLength(1);
  }
});

test("a settled return cannot be reused to resolve another call", async () => {
  const { peer } = createPeer();
  const first = peer.call({
    operation: "provider.call",
    provider: "store",
    tool: "get",
    argsJson: "[]",
  });
  const result = { type: "return", id: 1, result: { status: "ok", value: 42 } };
  peer.receive(encodeCodemodeFrame(result));
  assert((await first) === 42);
  peer.receive(encodeCodemodeFrame(result));
  assert(peer.closed);
});

test("too many unresolved calls rejects existing work rather than growing correlation maps", async () => {
  const { peer } = createPeer();
  const pending = Array.from({ length: CODEMODE_LIMITS.maxCalls + 1 }, () =>
    peer.call({ operation: "provider.call", provider: "store", tool: "get", argsJson: "[]" }),
  );
  const outcomes = await Promise.allSettled(pending);
  assert(peer.closed);
  assert(outcomes.every((outcome) => outcome.status === "rejected"));
});
