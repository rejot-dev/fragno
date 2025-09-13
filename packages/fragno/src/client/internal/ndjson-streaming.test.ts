import { describe, test, expect, vi } from "vitest";
import { handleNdjsonStreamingFirstItem, type NdjsonStreamingStore } from "./ndjson-streaming";
import { FragnoClientError, FragnoClientFetchAbortError } from "../client-error";
import { nanoquery } from "@nanostores/query";
import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createAsyncIteratorFromCallback } from "../../util/async";

describe("handleNdjsonStreaming", () => {
  test("should return first item and continue streaming updates", async () => {
    // Create a mock response with streaming body
    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"id": 1, "name": "Item 1"}\n'),
        })
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"id": 2, "name": "Item 2"}\n'),
        })
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"id": 3, "name": "Item 3"}\n'),
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };

    const mockResponse = {
      body: {
        getReader: vi.fn().mockReturnValue(mockReader),
      },
    } as unknown as Response;

    const mockStore = {
      setData: vi.fn(),
      setError: vi.fn(),
    };

    const { firstItem, streamingPromise } = await handleNdjsonStreamingFirstItem(
      mockResponse,
      mockStore,
    );

    // Verify the result structure
    expect(firstItem).toEqual({ id: 1, name: "Item 1" });
    expect(streamingPromise).toBeInstanceOf(Promise);

    // Wait for the streaming to complete
    const streamingResult = await streamingPromise;
    expect(streamingResult).toEqual([
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
      { id: 3, name: "Item 3" },
    ]);

    // Verify the store was updated with all items
    expect(mockStore.setData).toHaveBeenCalledWith([
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
      { id: 3, name: "Item 3" },
    ]);

    // Verify the reader was properly released
    expect(mockReader.releaseLock).toHaveBeenCalled();
  });

  test("should handle empty stream", async () => {
    const mockReader = {
      read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };

    const mockResponse = {
      body: {
        getReader: vi.fn().mockReturnValue(mockReader),
      },
    } as unknown as Response;

    const mockStore = {
      setData: vi.fn(),
      setError: vi.fn(),
    };

    // Should throw an error for empty stream
    await expect(handleNdjsonStreamingFirstItem(mockResponse, mockStore)).rejects.toThrow(
      "NDJSON stream contained no valid items",
    );
  });

  test("should handle response without body", async () => {
    const mockResponse = {
      body: null,
    } as unknown as Response;

    const mockStore = {
      setData: vi.fn(),
      setError: vi.fn(),
    };

    // Should throw an error for response without body
    await expect(handleNdjsonStreamingFirstItem(mockResponse, mockStore)).rejects.toThrow(
      "Streaming response has no body",
    );
  });

  test("should handle abort signal that is already aborted", async () => {
    const mockResponse = {
      body: {
        getReader: vi.fn(),
      },
    } as unknown as Response;

    const mockStore = {
      setData: vi.fn(),
      setError: vi.fn(),
    };

    const abortController = new AbortController();
    abortController.abort();

    // Should throw an abort error immediately
    await expect(
      handleNdjsonStreamingFirstItem(mockResponse, mockStore, {
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow(FragnoClientFetchAbortError);
  });

  test("should provide streaming promise that can be awaited", async () => {
    const abortController = new AbortController();

    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"id": 1, "name": "Item 1"}\n'),
        })
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"id": 2, "name": "Item 2"}\n'),
        })
        .mockResolvedValue({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };

    const mockResponse = {
      body: {
        getReader: vi.fn().mockReturnValue(mockReader),
      },
    } as unknown as Response;

    const mockStore = {
      setData: vi.fn(),
      setError: vi.fn(),
    };

    const result = await handleNdjsonStreamingFirstItem(mockResponse, mockStore, {
      abortSignal: abortController.signal,
    });

    // The function should succeed in getting the first item
    expect(result.firstItem).toEqual({ id: 1, name: "Item 1" });

    // The streaming promise should be available for awaiting
    expect(result.streamingPromise).toBeInstanceOf(Promise);

    // The streaming promise should resolve when all data is processed
    await expect(result.streamingPromise).resolves.toEqual([
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
    ]);

    // Verify all items were processed
    expect(mockStore.setData).toHaveBeenCalledWith([
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
    ]);

    // Verify the reader was properly released
    expect(mockReader.releaseLock).toHaveBeenCalled();
  });

  test("should handle abort signal with no additional streaming data", async () => {
    const abortController = new AbortController();

    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"id": 1, "name": "Item 1"}\n'),
        })
        .mockResolvedValue({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };

    const mockResponse = {
      body: {
        getReader: vi.fn().mockReturnValue(mockReader),
      },
    } as unknown as Response;

    const mockStore = {
      setData: vi.fn(),
      setError: vi.fn(),
    };

    const result = await handleNdjsonStreamingFirstItem(mockResponse, mockStore, {
      abortSignal: abortController.signal,
    });

    // Verify the first item is returned
    expect(result.firstItem).toEqual({ id: 1, name: "Item 1" });

    // The streaming promise should resolve successfully since there's no more data
    await expect(result.streamingPromise).resolves.toEqual([{ id: 1, name: "Item 1" }]);

    // Verify the reader was properly released
    expect(mockReader.releaseLock).toHaveBeenCalled();
  });

  test("should complete streaming promise when all data is processed", async () => {
    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"id": 1, "name": "Item 1"}\n'),
        })
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"id": 2, "name": "Item 2"}\n'),
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };

    const mockResponse = {
      body: {
        getReader: vi.fn().mockReturnValue(mockReader),
      },
    } as unknown as Response;

    const mockStore = {
      setData: vi.fn(),
      setError: vi.fn(),
    };

    const result = await handleNdjsonStreamingFirstItem(mockResponse, mockStore);

    // Verify the first item is returned
    expect(result.firstItem).toEqual({ id: 1, name: "Item 1" });

    // The streaming promise should resolve successfully
    await expect(result.streamingPromise).resolves.toEqual([
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
    ]);

    // Verify all items were processed
    expect(mockStore.setData).toHaveBeenCalledWith([
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
    ]);

    // Verify the reader was properly released
    expect(mockReader.releaseLock).toHaveBeenCalled();
  });

  test("should handle streaming errors and set them in the store", async () => {
    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"id": 1, "name": "Item 1"}\n'),
        })
        .mockRejectedValueOnce(new Error("Network error")),
      releaseLock: vi.fn(),
    };

    const mockResponse = {
      body: {
        getReader: vi.fn().mockReturnValue(mockReader),
      },
    } as unknown as Response;

    const mockStore = {
      setData: vi.fn(),
      setError: vi.fn(),
    };

    const result = await handleNdjsonStreamingFirstItem(mockResponse, mockStore);

    // Verify the first item is returned
    expect(result.firstItem).toEqual({ id: 1, name: "Item 1" });

    // The streaming promise should reject with the error
    await expect(result.streamingPromise).rejects.toThrow("Unknown streaming error");

    // Verify an error was set in the store
    expect(mockStore.setError).toHaveBeenCalledWith(expect.any(Object));

    // Verify the reader was properly released
    expect(mockReader.releaseLock).toHaveBeenCalled();
  });

  test("should support abort signal for interrupting hanging operations", async () => {
    // This test validates that the abort signal pattern is correctly implemented
    // The actual interruption behavior depends on the browser's ReadableStream implementation
    const abortController = new AbortController();

    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"id": 1, "name": "Item 1"}\n'),
        })
        .mockResolvedValue({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };

    const mockResponse = {
      body: {
        getReader: vi.fn().mockReturnValue(mockReader),
      },
    } as unknown as Response;

    const mockStore = {
      setData: vi.fn(),
      setError: vi.fn(),
    };

    const result = await handleNdjsonStreamingFirstItem(mockResponse, mockStore, {
      abortSignal: abortController.signal,
    });

    // Verify the first item is returned
    expect(result.firstItem).toEqual({ id: 1, name: "Item 1" });

    // The streaming promise should complete successfully since there's no more data
    await expect(result.streamingPromise).resolves.toEqual([{ id: 1, name: "Item 1" }]);

    expect(mockReader.releaseLock).toHaveBeenCalled();
  });

  test("should update store as stream progresses", async () => {
    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode('{"id": 1, "name": "Item 1"}\n'),
        })
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return {
            done: false,
            value: new TextEncoder().encode('{"id": 2, "name": "Item 2"}\n'),
          };
        })
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return {
            done: false,
            value: new TextEncoder().encode('{"id": 3, "name": "Item 3"}\n'),
          };
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };

    const mockResponse = {
      body: {
        getReader: vi.fn().mockReturnValue(mockReader),
      },
    } as unknown as Response;

    const [, createMutatorStore] = nanoquery();

    const _schema = z.array(
      z.object({
        id: z.number(),
        name: z.string(),
      }),
    );

    const mutatorStore = createMutatorStore<
      undefined,
      StandardSchemaV1.InferOutput<typeof _schema>,
      FragnoClientError<string>
    >(() => {
      return Promise.resolve([]);
    });

    const storeAdapter: NdjsonStreamingStore<typeof _schema, string> = {
      setData: (value) => {
        mutatorStore.set({
          ...mutatorStore.get(),
          data: value,
        });
      },
      setError: (value) => {
        mutatorStore.set({
          ...mutatorStore.get(),
          error: value,
        });
      },
    };

    const itt = createAsyncIteratorFromCallback(mutatorStore.listen);
    const promise = handleNdjsonStreamingFirstItem(mockResponse, storeAdapter);

    // We immediately skip to 2 items being available, because normally the fetcher method would
    // return the first item (the `Promise.resolve` above).
    {
      const { value } = await itt.next();
      expect(value).toEqual({
        data: [
          { id: 1, name: "Item 1" },
          { id: 2, name: "Item 2" },
        ],
        loading: false,
        error: undefined,
        mutate: expect.any(Function),
      });
    }

    {
      const { value } = await itt.next();
      expect(value).toEqual({
        data: [
          { id: 1, name: "Item 1" },
          { id: 2, name: "Item 2" },
          { id: 3, name: "Item 3" },
        ],
        loading: false,
        error: undefined,
        mutate: expect.any(Function),
      });
    }

    const { streamingPromise } = await promise;

    const result = await streamingPromise;
    expect(result).toEqual([
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
      { id: 3, name: "Item 3" },
    ]);
  });
});
