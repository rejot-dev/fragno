import { assert, test } from "vitest";

import { RpcStub, RpcTarget } from "capnweb";

import { createNodePeerForwardingTarget } from "./node-peer-object-forwarder";

test("Request and Response streams cross consecutive Cap'n Web sessions", async () => {
  const workerTarget = new RpcStub(new StreamingObjectTarget());
  let authorityChecks = 0;
  using routedObject = new RpcStub<StreamingObjectTarget>(
    createNodePeerForwardingTarget(
      async () => workerTarget.dup(),
      () => {
        authorityChecks += 1;
      },
    ) as StreamingObjectTarget,
  );
  const request = new Request("https://peer-object.test/stream", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("request stream"));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);

  const response = await routedObject.fetch(request);

  assert.equal(response.status, 202);
  assert.equal(await response.text(), "received request stream");
  assert.ok(authorityChecks >= 3);
  workerTarget[Symbol.dispose]();
});

class StreamingObjectTarget extends RpcTarget {
  async fetch(request: Request): Promise<Response> {
    const body = await request.text();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`received ${body}`));
          controller.close();
        },
      }),
      { status: 202 },
    );
  }
}
