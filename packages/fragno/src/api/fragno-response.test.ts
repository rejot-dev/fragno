import { assert, describe, expect, it, vi } from "vitest";

import { parseFragnoResponse } from "./fragno-response";

const encoder = new TextEncoder();

function ndjsonResponse(
  chunks: Uint8Array[],
  options: { close: boolean; cancel?: () => void } = { close: true },
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        if (options.close) {
          controller.close();
        }
      },
      cancel() {
        options.cancel?.();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
}

async function collectStream<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
}

describe("parseFragnoResponse NDJSON", () => {
  it("parses complete frames without requiring a trailing newline", async () => {
    const response = ndjsonResponse([
      encoder.encode('{"id":1}\n'),
      encoder.encode('\n  \n{"id":2}\n{"id":3}'),
    ]);

    const parsed = await parseFragnoResponse<Array<{ id: number }>>(response);
    assert(parsed.type === "jsonStream");
    await expect(collectStream(parsed.stream)).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("joins only a frame that crosses chunk boundaries", async () => {
    const response = ndjsonResponse([
      encoder.encode('{"message":"hel'),
      encoder.encode('lo"}\n{"message":"world"'),
      encoder.encode("}\n"),
    ]);

    const parsed = await parseFragnoResponse<Array<{ message: string }>>(response);
    if (parsed.type !== "jsonStream") {
      throw new Error("Expected an NDJSON stream response.");
    }
    await expect(collectStream(parsed.stream)).resolves.toEqual([
      { message: "hello" },
      { message: "world" },
    ]);
  });

  it("preserves UTF-8 characters split between byte chunks", async () => {
    const bytes = encoder.encode('{"text":"rain 雨 and wave 🌊"}\n');
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    const response = ndjsonResponse(chunks);

    const parsed = await parseFragnoResponse<Array<{ text: string }>>(response);
    if (parsed.type !== "jsonStream") {
      throw new Error("Expected an NDJSON stream response.");
    }
    await expect(collectStream(parsed.stream)).resolves.toEqual([{ text: "rain 雨 and wave 🌊" }]);
  });

  it("cancels an unfinished response when consumption stops", async () => {
    const cancel = vi.fn();
    const response = ndjsonResponse([encoder.encode('{"id":1}\n')], { close: false, cancel });

    const parsed = await parseFragnoResponse<Array<{ id: number }>>(response);
    if (parsed.type !== "jsonStream") {
      throw new Error("Expected an NDJSON stream response.");
    }
    await expect(parsed.stream.next()).resolves.toEqual({ value: { id: 1 }, done: false });
    await parsed.stream.return(undefined);

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not cancel a response consumed through normal completion", async () => {
    const cancel = vi.fn();
    const response = ndjsonResponse([encoder.encode('{"id":1}\n')], { close: true, cancel });

    const parsed = await parseFragnoResponse<Array<{ id: number }>>(response);
    if (parsed.type !== "jsonStream") {
      throw new Error("Expected an NDJSON stream response.");
    }
    await expect(collectStream(parsed.stream)).resolves.toEqual([{ id: 1 }]);

    expect(cancel).not.toHaveBeenCalled();
  });
});
