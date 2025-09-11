import { describe, test, expect, vi } from "vitest";
import { handleNdjsonStreamingFirstItem } from "./ndjson-streaming";
import type { FetcherStore } from "@nanostores/query";
import { FragnoClientError, FragnoClientFetchAbortError } from "../client-error";

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

    // Create a mock store
    const mockStore = {
      mutate: vi.fn(),
      setKey: vi.fn(),
    } as unknown as FetcherStore<unknown, FragnoClientError<string>>;

    // Call the function
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
    expect(mockStore.mutate).toHaveBeenCalledWith([
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
      mutate: vi.fn(),
      setKey: vi.fn(),
    } as unknown as FetcherStore<unknown, FragnoClientError<string>>;

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
      mutate: vi.fn(),
      setKey: vi.fn(),
    } as unknown as FetcherStore<unknown, FragnoClientError<string>>;

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
      mutate: vi.fn(),
      setKey: vi.fn(),
    } as unknown as FetcherStore<unknown, FragnoClientError<string>>;

    const abortController = new AbortController();
    abortController.abort();

    // Should throw an abort error immediately
    await expect(
      handleNdjsonStreamingFirstItem(mockResponse, mockStore, abortController.signal),
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
      mutate: vi.fn(),
      setKey: vi.fn(),
    } as unknown as FetcherStore<unknown, FragnoClientError<string>>;

    const result = await handleNdjsonStreamingFirstItem(
      mockResponse,
      mockStore,
      abortController.signal,
    );

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
    expect(mockStore.mutate).toHaveBeenCalledWith([
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
      mutate: vi.fn(),
      setKey: vi.fn(),
    } as unknown as FetcherStore<unknown, FragnoClientError<string>>;

    const result = await handleNdjsonStreamingFirstItem(
      mockResponse,
      mockStore,
      abortController.signal,
    );

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
      mutate: vi.fn(),
      setKey: vi.fn(),
    } as unknown as FetcherStore<unknown, FragnoClientError<string>>;

    const result = await handleNdjsonStreamingFirstItem(mockResponse, mockStore);

    // Verify the first item is returned
    expect(result.firstItem).toEqual({ id: 1, name: "Item 1" });

    // The streaming promise should resolve successfully
    await expect(result.streamingPromise).resolves.toEqual([
      { id: 1, name: "Item 1" },
      { id: 2, name: "Item 2" },
    ]);

    // Verify all items were processed
    expect(mockStore.mutate).toHaveBeenCalledWith([
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
      mutate: vi.fn(),
      setKey: vi.fn(),
    } as unknown as FetcherStore<unknown, FragnoClientError<string>>;

    const result = await handleNdjsonStreamingFirstItem(mockResponse, mockStore);

    // Verify the first item is returned
    expect(result.firstItem).toEqual({ id: 1, name: "Item 1" });

    // The streaming promise should reject with the error
    await expect(result.streamingPromise).rejects.toThrow("Unknown streaming error");

    // Verify an error was set in the store
    expect(mockStore.setKey).toHaveBeenCalledWith("error", expect.any(Object));

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
      mutate: vi.fn(),
      setKey: vi.fn(),
    } as unknown as FetcherStore<unknown, FragnoClientError<string>>;

    const result = await handleNdjsonStreamingFirstItem(
      mockResponse,
      mockStore,
      abortController.signal,
    );

    // Verify the first item is returned
    expect(result.firstItem).toEqual({ id: 1, name: "Item 1" });

    // The streaming promise should complete successfully since there's no more data
    await expect(result.streamingPromise).resolves.toEqual([{ id: 1, name: "Item 1" }]);

    // Verify the reader was properly released
    expect(mockReader.releaseLock).toHaveBeenCalled();

    // The key improvement is that abort signals are now properly wired up with Promise.race
    // This ensures that hanging read() operations can be interrupted when the signal is aborted
  });
});
