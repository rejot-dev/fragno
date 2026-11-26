// @vitest-environment happy-dom

import { afterEach, assert, expect, test } from "vitest";

import type { PiAgentEntryRange } from "@fragno-dev/backoffice-api/v0/pi";

import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { usePiTranscript, type PiEntryPage } from "./transcript";

afterEach(cleanup);

const conversation = Array.from(
  { length: 600 },
  (_, index) => ({ id: index + 1, kind: "pi.user" }) as unknown as EntryRecord,
);

/**
 * Pages `conversation` as the entries route does, recording each range asked for. The next
 * requests can be made to fail, or to wait until released.
 */
function entriesRoute() {
  const ranges: PiAgentEntryRange[] = [];
  const plans: ("fail" | Promise<void>)[] = [];
  async function readPage(range: PiAgentEntryRange): Promise<PiEntryPage> {
    ranges.push(range);
    const plan = plans.shift();
    if (plan === "fail") {
      throw new Error("Pi history request failed with status 502.");
    }
    await plan;
    const inRange = conversation.filter(
      ({ id }) =>
        (range.minEntryId === null || id >= range.minEntryId) &&
        (range.maxEntryId === null || id <= range.maxEntryId),
    );
    const ordered = range.order === "descending" ? inRange.reverse() : inRange;
    return { entries: ordered.slice(0, range.pageSize), more: ordered.length > range.pageSize };
  }
  return {
    ranges,
    readPage,
    failNext() {
      plans.push("fail");
    },
    /** Holds the next request until the returned function is called. */
    holdNext() {
      const { promise, resolve } = Promise.withResolvers<void>();
      plans.push(promise);
      return resolve;
    },
  };
}

/** The watch's window over entries `from` through `to`. */
function windowOf(from: number, to: number): ConversationView {
  return {
    entries: conversation.slice(from - 1, to),
    ...(from > 1 ? { before: from - 1 } : {}),
    docs: {},
  } as unknown as ConversationView;
}

function ids(entries: readonly EntryRecord[]) {
  return [entries[0]?.id, entries.at(-1)?.id, entries.length];
}

test("the chat keeps earlier history as the window moves on, and loads what a reconnect skipped", async () => {
  const route = entriesRoute();
  const { result, rerender } = renderHook(
    ({ view }: { view: ConversationView }) => usePiTranscript(view, route.readPage),
    { initialProps: { view: windowOf(151, 200) } },
  );
  assert.isTrue(result.current.hasMore);

  await act(() => result.current.loadMore());
  expect(ids(result.current.transcript)).toEqual([51, 200, 150]);
  expect(route.ranges).toEqual([
    { minEntryId: null, maxEntryId: 150, order: "descending", pageSize: 100 },
  ]);

  // Past 100 entries the window drops its oldest; what the chat loaded stays.
  rerender({ view: windowOf(151, 250) });
  rerender({ view: windowOf(201, 250) });
  expect(ids(result.current.transcript)).toEqual([51, 250, 200]);

  // A reconnect's window starts past what the chat has; the entries between load at once.
  rerender({ view: windowOf(261, 300) });
  await waitFor(() => expect(ids(result.current.transcript)).toEqual([51, 300, 250]));
  expect(route.ranges.at(-1)).toEqual({
    minEntryId: 251,
    maxEntryId: 260,
    order: "ascending",
    pageSize: 100,
  });
  assert.isTrue(result.current.hasMore);
  assert.isNull(result.current.error);
});

test("a reconnect's missed messages that fail to load can be retried once no earlier history remains", async () => {
  const route = entriesRoute();
  const { result, rerender } = renderHook(
    ({ view }: { view: ConversationView }) => usePiTranscript(view, route.readPage),
    { initialProps: { view: windowOf(1, 50) } },
  );
  // The window starts the conversation, so there is nothing earlier to load.
  assert.isFalse(result.current.hasMore);
  expect(result.current.retry).toBeNull();

  route.failNext();
  rerender({ view: windowOf(61, 100) });
  await waitFor(() => assert.isNotNull(result.current.error));
  expect(ids(result.current.transcript)).toEqual([1, 100, 90]);
  assert.isFalse(result.current.hasMore);
  // A failure waits for the reader rather than asking again on its own.
  expect(route.ranges).toHaveLength(1);

  const { retry } = result.current;
  assert(retry !== null);
  await act(() => retry());
  await waitFor(() => expect(ids(result.current.transcript)).toEqual([1, 100, 100]));
  assert.isNull(result.current.error);
  assert.isNull(result.current.retry);
  expect(route.ranges.at(-1)).toEqual({
    minEntryId: 51,
    maxEntryId: 60,
    order: "ascending",
    pageSize: 100,
  });
});

test("missed messages keep loading while a page of earlier history fails", async () => {
  const route = entriesRoute();
  const { result, rerender } = renderHook(
    ({ view }: { view: ConversationView }) => usePiTranscript(view, route.readPage),
    { initialProps: { view: windowOf(201, 250) } },
  );

  // A reconnect misses 250 entries, more than one page.
  const releaseFirstGapPage = route.holdNext();
  rerender({ view: windowOf(501, 550) });
  await waitFor(() => expect(route.ranges).toHaveLength(1));

  route.failNext();
  await act(() => result.current.loadMore());
  expect(route.ranges.at(-1)).toEqual({
    minEntryId: null,
    maxEntryId: 200,
    order: "descending",
    pageSize: 100,
  });
  assert.isNotNull(result.current.error);

  releaseFirstGapPage();
  await waitFor(() => expect(ids(result.current.transcript)).toEqual([201, 550, 350]));
  expect(route.ranges.filter((range) => range.order === "ascending")).toEqual([
    { minEntryId: 251, maxEntryId: 500, order: "ascending", pageSize: 100 },
    { minEntryId: 351, maxEntryId: 500, order: "ascending", pageSize: 100 },
    { minEntryId: 451, maxEntryId: 500, order: "ascending", pageSize: 100 },
  ]);
  // The failed page of earlier history still waits for the reader.
  assert.isNotNull(result.current.retry);
  assert.isTrue(result.current.hasMore);

  const { retry } = result.current;
  assert(retry !== null);
  await act(() => retry());
  expect(ids(result.current.transcript)).toEqual([101, 550, 450]);
  assert.isNull(result.current.error);
  assert.isNull(result.current.retry);
});
