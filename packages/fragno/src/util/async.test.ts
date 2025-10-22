import { describe, expect, test } from "vitest";
import { createAsyncIteratorFromCallback, waitForAsyncIterator } from "./async";

describe("createAsyncIteratorFromCallback", () => {
  test("yields values from callback", async () => {
    let callback: ((value: string) => void) | null = null;
    let unsubscribeCalled = false;

    const subscribe = (cb: (value: string) => void) => {
      callback = cb;
      return () => {
        unsubscribeCalled = true;
      };
    };

    const iterator = createAsyncIteratorFromCallback(subscribe);

    // Start consuming the iterator
    const consumePromise = (async () => {
      const values: string[] = [];
      for await (const value of iterator) {
        values.push(value);
        if (values.length === 3) {
          break;
        }
      }
      return values;
    })();

    // Emit values
    callback!("first");
    callback!("second");
    callback!("third");

    const result = await consumePromise;
    expect(result).toEqual(["first", "second", "third"]);
    expect(unsubscribeCalled).toBe(true);
  });

  test("calls unsubscribe when iterator is terminated early", async () => {
    let callback: ((value: string) => void) | null = null;
    let unsubscribeCalled = false;

    const subscribe = (cb: (value: string) => void) => {
      callback = cb;
      return () => {
        unsubscribeCalled = true;
      };
    };

    const iterator = createAsyncIteratorFromCallback(subscribe);

    // Start consuming but break early
    const consumePromise = (async () => {
      const values: string[] = [];
      for await (const value of iterator) {
        values.push(value);
        if (values.length === 2) {
          break;
        } // Break after 2 values
      }
      return values;
    })();

    // Emit 3 values
    callback!("first");
    callback!("second");
    callback!("third");

    const result = await consumePromise;
    expect(result).toEqual(["first", "second"]);
    expect(unsubscribeCalled).toBe(true);
  });
});

describe("waitForAsyncIterator", () => {
  test("actually times out", async () => {
    const iterable = {
      [Symbol.asyncIterator]: async function* () {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        yield "test";
      },
    };

    await expect(waitForAsyncIterator(iterable, () => false, { timeout: 1 })).rejects.toThrow(
      "waitForAsyncIterator: Timeout after 1ms",
    );
  });
});
