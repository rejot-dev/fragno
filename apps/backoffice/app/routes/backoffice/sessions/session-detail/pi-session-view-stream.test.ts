import { expect, test } from "vitest";

import { consumePiSessionViewNdjson } from "./pi-session-view-stream";

const encoder = new TextEncoder();

test("reads Pi session view NDJSON across arbitrary transport chunks", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"snapshot","view":{"conversation":{"id":1},'));
        controller.enqueue(encoder.encode('"entries":[],"docs":{}}}\n{"type":"up'));
        controller.enqueue(
          encoder.encode(
            'date","view":{"conversation":{"id":1},"entries":[{"id":1}],"docs":{}}}\n',
          ),
        );
        controller.close();
      },
    }),
  );
  const frames: unknown[] = [];

  await consumePiSessionViewNdjson(response, (frame) => {
    frames.push(frame);
  });

  expect(frames).toEqual([
    {
      type: "snapshot",
      view: { conversation: { id: 1 }, entries: [], docs: {} },
    },
    {
      type: "update",
      view: { conversation: { id: 1 }, entries: [{ id: 1 }], docs: {} },
    },
  ]);
});
