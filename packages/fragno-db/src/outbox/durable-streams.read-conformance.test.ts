import { describe, expect, it, assert } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stream } from "@durable-streams/client";

import {
  handleDurableStreamRequest,
  outboxVersionstampToStreamOffset,
  streamOffsetToAfterVersionstamp,
} from "./durable-streams";
import {
  createDurableStreamsReadFixture,
  DURABLE_STREAMS_TEST_ZERO_OFFSET,
  type DurableStreamsReadFixture,
} from "./durable-streams.test-fixture";
import type { OutboxEntry } from "./outbox";

const STREAM_OFFSET_PATTERN = /^[0-9a-f]{25}$/;

const nextOffset = (response: Response) => response.headers.get("Stream-Next-Offset");
const isUpToDate = (response: Response) => response.headers.get("Stream-Up-To-Date") === "true";

const readEntries = async (response: Response): Promise<Array<Record<string, unknown>>> =>
  (await response.json()) as Array<Record<string, unknown>>;

async function withFixture(
  run: (fixture: DurableStreamsReadFixture) => Promise<void>,
  options?: Parameters<typeof createDurableStreamsReadFixture>[0],
): Promise<void> {
  const fixture = await createDurableStreamsReadFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

async function within<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for test operation.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

describe("Durable Streams read-path conformance", () => {
  describe("HEAD metadata", () => {
    it("returns metadata without a body for an empty schema stream", async () => {
      await withFixture(async ({ streamUrl }) => {
        const response = await fetch(streamUrl, { method: "HEAD" });

        assert(response.status === 200);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(nextOffset(response)).toBe(DURABLE_STREAMS_TEST_ZERO_OFFSET);
        expect(response.headers.get("cache-control")).toContain("no-store");
        assert(response.headers.get("x-content-type-options") === "nosniff");
        assert(response.headers.get("cross-origin-resource-policy") === "cross-origin");
        assert((await response.text()) === "");
      });
    });

    it("returns the global outbox watermark as the tail offset", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation, appendUnrelatedMutation }) => {
        await appendTargetMutation();
        const unrelatedEntry = await appendUnrelatedMutation();

        const response = await fetch(streamUrl, { method: "HEAD" });

        expect(nextOffset(response)).toMatch(STREAM_OFFSET_PATTERN);
        expect(nextOffset(response)).toBe(
          outboxVersionstampToStreamOffset(unrelatedEntry.versionstamp as string),
        );
      });
    });

    it("does not expose registered schemas that did not opt into the outbox", async () => {
      await withFixture(
        async ({ streamUrlFor }) => {
          const response = await fetch(streamUrlFor("durable_streams_beta"), { method: "HEAD" });
          assert(response.status === 404);
        },
        { betaOutboxEnabled: false },
      );
    });
  });

  describe("catch-up reads", () => {
    it("reads from the beginning when offset is omitted or -1", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        const first = await appendTargetMutation("first");
        const second = await appendTargetMutation("second");

        for (const url of [streamUrl, `${streamUrl}?offset=-1`]) {
          const response = await fetch(url);
          assert(response.status === 200);
          expect((await readEntries(response)).map((entry) => entry["versionstamp"])).toEqual([
            first.versionstamp,
            second.versionstamp,
          ]);
          expect(nextOffset(response)).toMatch(STREAM_OFFSET_PATTERN);
          assert(isUpToDate(response));
        }
      });
    });

    it("resumes exclusively from a returned offset without duplicates", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        await appendTargetMutation("first");
        const initialResponse = await fetch(streamUrl);
        const firstOffset = nextOffset(initialResponse);
        expect(firstOffset).toMatch(STREAM_OFFSET_PATTERN);

        const second = await appendTargetMutation("second");
        const resumedResponse = await fetch(`${streamUrl}?offset=${firstOffset as string}`);

        expect((await readEntries(resumedResponse)).map((entry) => entry["versionstamp"])).toEqual([
          second.versionstamp,
        ]);
        expect(nextOffset(resumedResponse)).not.toBe(firstOffset);
      });
    });

    it("returns an empty JSON array when reading from the tail", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        await appendTargetMutation();
        const initialResponse = await fetch(streamUrl);
        const tailOffset = nextOffset(initialResponse);
        const response = await fetch(`${streamUrl}?offset=${tailOffset as string}`);

        assert(response.status === 200);
        assert((await response.text()) === "[]");
        expect(nextOffset(response)).toBe(tailOffset);
        assert(isUpToDate(response));
      });
    });

    it("supports offset=now and resumes from the returned tail", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        await appendTargetMutation("historical");
        const nowResponse = await fetch(`${streamUrl}?offset=now`);

        assert(nowResponse.status === 200);
        assert((await nowResponse.text()) === "[]");
        expect(nextOffset(nowResponse)).toMatch(STREAM_OFFSET_PATTERN);
        assert(isUpToDate(nowResponse));
        expect(nowResponse.headers.get("etag")).toBeNull();

        const future = await appendTargetMutation("future");
        const resumedResponse = await fetch(
          `${streamUrl}?offset=${nextOffset(nowResponse) as string}`,
        );
        expect((await readEntries(resumedResponse)).map((entry) => entry["versionstamp"])).toEqual([
          future.versionstamp,
        ]);
      });
    });

    it("returns bounded pages with an exact up-to-date signal", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        for (let index = 0; index < 101; index += 1) {
          await appendTargetMutation(`page-${index}`);
        }

        const firstResponse = await fetch(streamUrl);
        expect(await readEntries(firstResponse)).toHaveLength(100);
        assert(!isUpToDate(firstResponse));

        const secondResponse = await fetch(
          `${streamUrl}?offset=${nextOffset(firstResponse) as string}`,
        );
        expect(await readEntries(secondResponse)).toHaveLength(1);
        assert(isUpToDate(secondResponse));
      });
    });

    it("advances through a full page of unrelated entries", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation, appendUnrelatedMutation }) => {
        for (let index = 0; index < 100; index += 1) {
          await appendUnrelatedMutation(`unrelated-${index}`);
        }
        const target = await appendTargetMutation("after-unrelated-page");

        const firstResponse = await fetch(streamUrl);
        expect(await readEntries(firstResponse)).toEqual([]);
        assert(!isUpToDate(firstResponse));
        const firstOffset = nextOffset(firstResponse);
        expect(firstOffset).toMatch(STREAM_OFFSET_PATTERN);

        const secondResponse = await fetch(`${streamUrl}?offset=${firstOffset as string}`);
        expect((await readEntries(secondResponse)).map((entry) => entry["versionstamp"])).toEqual([
          target.versionstamp,
        ]);
        assert(isUpToDate(secondResponse));
      });
    });

    it("validates offset cardinality, syntax, case, and range", async () => {
      await withFixture(async ({ streamUrl }) => {
        const invalidQueries = [
          "offset=",
          "offset=abc",
          "offset=a&offset=b",
          "offset=0%2C1",
          `offset=${"A".repeat(25)}`,
          `offset=${"f".repeat(25)}`,
        ];
        for (const query of invalidQueries) {
          const response = await fetch(`${streamUrl}?${query}`);
          assert(response.status === 400, query);
          assert(response.headers.get("x-content-type-options") === "nosniff");
        }
      });
    });

    it("supports the maximum outbox versionstamp without minting an unusable offset", () => {
      const maximumVersionstamp = "f".repeat(24);
      const offset = outboxVersionstampToStreamOffset(maximumVersionstamp);

      expect(offset).toBe(`1${"0".repeat(24)}`);
      expect(streamOffsetToAfterVersionstamp(offset)).toBe(maximumVersionstamp);
    });

    it("maps outbox positions to unique, ordered, reversible stream offsets", () => {
      const versionstamps = Array.from({ length: 1_000 }, (_, index) =>
        BigInt(index).toString(16).padStart(24, "0"),
      );
      const offsets = versionstamps.map(outboxVersionstampToStreamOffset);

      expect(new Set(offsets).size).toBe(offsets.length);
      for (let index = 0; index < offsets.length; index += 1) {
        expect(streamOffsetToAfterVersionstamp(offsets[index] as string)).toBe(
          versionstamps[index],
        );
        if (index > 0) {
          assert((offsets[index] as string) > (offsets[index - 1] as string));
        }
      }
    });

    it("ignores unknown query parameters", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        const entry = await appendTargetMutation();
        const response = await fetch(`${streamUrl}?offset=-1&unknown=value`);

        assert(response.status === 200);
        expect((await readEntries(response))[0]?.["versionstamp"]).toBe(entry.versionstamp);
      });
    });
  });

  describe("schema projection", () => {
    it("filters unrelated schema entries while advancing the global watermark", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation, appendUnrelatedMutation }) => {
        const first = await appendTargetMutation("first");
        await appendUnrelatedMutation();
        const second = await appendTargetMutation("second");

        const response = await fetch(streamUrl);
        expect((await readEntries(response)).map((entry) => entry["versionstamp"])).toEqual([
          first.versionstamp,
          second.versionstamp,
        ]);
        expect(nextOffset(response)).toMatch(STREAM_OFFSET_PATTERN);
      });
    });

    it("matches custom database namespaces through schema and namespace URLs", async () => {
      await withFixture(
        async ({ streamUrl, streamUrlFor, appendTargetMutation }) => {
          const entry = await appendTargetMutation();

          for (const url of [streamUrl, streamUrlFor("durable_streams_alpha")]) {
            const response = await fetch(url);
            assert(response.status === 200);
            expect((await readEntries(response))[0]?.["versionstamp"]).toBe(entry.versionstamp);
          }
        },
        { targetNamespace: "tenant-alpha", streamPath: "namespace" },
      );
    });

    it("requires a namespace URL when one logical schema is registered more than once", async () => {
      await withFixture(
        async ({ streamUrlFor, appendTargetMutation }) => {
          await appendTargetMutation();

          const ambiguousName = await fetch(streamUrlFor("durable_streams_alpha"));
          assert(ambiguousName.status === 404);

          const primaryNamespace = await fetch(streamUrlFor("tenant-primary"));
          assert(primaryNamespace.status === 200);
          expect(await readEntries(primaryNamespace)).toHaveLength(1);

          const secondaryNamespace = await fetch(streamUrlFor("tenant-secondary"));
          assert(secondaryNamespace.status === 200);
          expect(await readEntries(secondaryNamespace)).toEqual([]);
        },
        {
          targetNamespace: "tenant-primary",
          streamPath: "namespace",
          secondaryTargetNamespace: "tenant-secondary",
        },
      );
    });

    it("uses the logical name for a null-namespace registration when that name is repeated", async () => {
      await withFixture(
        async ({ streamUrlFor, appendTargetMutation }) => {
          const entry = await appendTargetMutation();

          const nullNamespaceStream = await fetch(streamUrlFor("durable_streams_alpha"));
          assert(nullNamespaceStream.status === 200);
          expect((await readEntries(nullNamespaceStream))[0]?.["versionstamp"]).toBe(
            entry.versionstamp,
          );

          const namedNamespaceStream = await fetch(streamUrlFor("tenant-secondary"));
          assert(namedNamespaceStream.status === 200);
          expect(await readEntries(namedNamespaceStream)).toEqual([]);
        },
        {
          targetNamespace: null,
          secondaryTargetNamespace: "tenant-secondary",
        },
      );
    });

    it("matches URL-encoded database namespaces containing slashes", async () => {
      await withFixture(
        async ({ streamUrl, appendTargetMutation }) => {
          const entry = await appendTargetMutation();
          const response = await fetch(streamUrl);

          assert(response.status === 200);
          expect((await readEntries(response))[0]?.["versionstamp"]).toBe(entry.versionstamp);
        },
        {
          targetNamespace: "tenant/alpha",
          streamPath: "namespace",
        },
      );
    });

    it("matches schemas without a database namespace by logical schema name", async () => {
      await withFixture(
        async ({ streamUrl, appendTargetMutation }) => {
          const entry = await appendTargetMutation();
          const response = await fetch(streamUrl);
          const [message] = await readEntries(response);

          assert(response.status === 200);
          expect(message?.["versionstamp"]).toBe(entry.versionstamp);
          const payload = message?.["payload"] as {
            json: { mutations: Array<Record<string, unknown>> };
          };
          expect(payload.json.mutations[0]).toMatchObject({
            schema: "",
            schemaName: "durable_streams_alpha",
          });
          expect(payload.json.mutations[0]?.["namespace"]).toBeNull();
        },
        { targetNamespace: null },
      );
    });

    it("continues matching legacy custom-namespace entries without schemaName", async () => {
      const legacyEntry = {
        versionstamp: "0".repeat(24),
        payload: {
          json: {
            version: 1,
            mutations: [{ schema: "tenant-alpha", namespace: "tenant-alpha" }],
          },
        },
      } as OutboxEntry;

      const response = await handleDurableStreamRequest({
        method: "GET",
        schema: { name: "durable_streams_alpha", namespace: "tenant-alpha" },
        query: new URLSearchParams(),
        listOutboxEntries: async () => [legacyEntry],
        getTailOffset: async () => legacyEntry.versionstamp,
      });

      expect((await readEntries(response))[0]?.["versionstamp"]).toBe(legacyEntry.versionstamp);
    });

    it("does not guess a logical schema for ambiguous legacy null-namespace entries", async () => {
      const legacyEntry = {
        versionstamp: "0".repeat(24),
        payload: {
          json: {
            version: 1,
            mutations: [{ schema: "" }],
          },
        },
      } as OutboxEntry;

      const response = await handleDurableStreamRequest({
        method: "GET",
        schema: { name: "durable_streams_alpha", namespace: null },
        query: new URLSearchParams(),
        listOutboxEntries: async () => [legacyEntry],
        getTailOffset: async () => legacyEntry.versionstamp,
      });

      expect(await readEntries(response)).toEqual([]);
    });

    it("fails without advancing past a malformed projected outbox entry", async () => {
      const malformedEntry = {
        versionstamp: "0".repeat(24),
        payload: {
          json: {
            version: 1,
            mutations: [
              {
                schema: "alpha",
                schemaName: "alpha",
                namespace: "alpha",
              },
              null,
            ],
          },
        },
      } as OutboxEntry;

      const response = await handleDurableStreamRequest({
        method: "GET",
        schema: { name: "alpha", namespace: "alpha" },
        query: new URLSearchParams(),
        listOutboxEntries: async () => [malformedEntry],
        getTailOffset: async () => malformedEntry.versionstamp,
      });

      assert(response.status === 500);
      expect(nextOffset(response)).toBeNull();
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "INVALID_OUTBOX_PAYLOAD",
        },
      });
    });

    it("preserves a complete atomic transaction in every schema stream it touches", async () => {
      await withFixture(async ({ streamUrl, streamUrlFor, appendMixedMutation }) => {
        const mixedEntry = await appendMixedMutation();

        for (const url of [streamUrl, streamUrlFor("durable_streams_beta")]) {
          const response = await fetch(url);
          const messages = await readEntries(response);
          const message = messages.find(
            (candidate) => candidate["versionstamp"] === mixedEntry.versionstamp,
          );
          const payload = message?.["payload"] as {
            json: { mutations: Array<{ schemaName: string; namespace?: string }> };
          };

          expect(payload.json.mutations.map((mutation) => mutation.schemaName)).toEqual([
            "durable_streams_alpha",
            "durable_streams_beta",
          ]);
        }
      });
    });
  });

  describe("JSON message representation", () => {
    it("serializes each OutboxEntry as one stable JSON message", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        await appendTargetMutation();
        const response = await fetch(streamUrl);
        const [entry] = await readEntries(response);

        expect(entry).toMatchObject({
          id: {
            externalId: expect.any(String),
            internalId: expect.any(String),
          },
          versionstamp: expect.stringMatching(/^[0-9a-f]{24}$/),
          uowId: expect.any(String),
          payload: {
            json: {
              version: 1,
              mutations: expect.any(Array),
            },
            meta: expect.any(Object),
          },
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        });
      });
    });

    it("preserves reference maps over the production HTTP route", async () => {
      await withFixture(async ({ streamUrl, appendReferenceMutation }) => {
        const referenceEntry = await appendReferenceMutation();
        const response = await fetch(streamUrl);
        const entry = (await readEntries(response)).find(
          (candidate) => candidate["versionstamp"] === referenceEntry.versionstamp,
        );

        expect(entry?.["refMap"]).toEqual({
          "0.authorId": expect.any(String),
        });
        expect(entry?.["payload"]).toMatchObject({
          json: {
            mutations: [
              {
                values: {
                  authorId: { __fragno_ref: "0.authorId" },
                },
              },
            ],
          },
        });
      });
    });
  });

  describe("long-poll", () => {
    it("returns relevant entries that already exist with a cursor and ETag", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        const entry = await appendTargetMutation();
        const response = await fetch(
          `${streamUrl}?offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll`,
        );

        assert(response.status === 200);
        expect((await readEntries(response))[0]?.["versionstamp"]).toBe(entry.versionstamp);
        expect(response.headers.get("stream-cursor")).toMatch(/^\d+$/);
        expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]+"$/);
      });
    });

    it("honors If-None-Match on an immediate long-poll data response", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        await appendTargetMutation();
        const url = `${streamUrl}?offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll`;
        const firstResponse = await fetch(url);
        const etag = firstResponse.headers.get("etag");
        await firstResponse.body?.cancel();

        const secondResponse = await fetch(url, { headers: { "If-None-Match": etag as string } });
        assert(secondResponse.status === 304);
        assert((await secondResponse.text()) === "");
      });
    });

    it("does not attach an ETag to offset=now long-poll responses", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        const responsePromise = fetch(`${streamUrl}?offset=now&live=long-poll`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await appendTargetMutation("future");

        const response = await responsePromise;
        assert(response.status === 200);
        expect(response.headers.get("etag")).toBeNull();
      });
    });

    it("ignores unrelated traffic and waits for a relevant mutation", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation, appendUnrelatedMutation }) => {
        const responsePromise = fetch(
          `${streamUrl}?offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll`,
        );

        await new Promise((resolve) => setTimeout(resolve, 50));
        await appendUnrelatedMutation();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const relevantEntry = await appendTargetMutation();

        const response = await responsePromise;
        assert(response.status === 200);
        expect((await readEntries(response)).map((entry) => entry["versionstamp"])).toEqual([
          relevantEntry.versionstamp,
        ]);
      });
    });

    it("returns the required headers on timeout", async () => {
      await withFixture(async ({ streamUrl }) => {
        const response = await fetch(
          `${streamUrl}?offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll`,
        );

        assert(response.status === 204);
        expect(nextOffset(response)).toBe(DURABLE_STREAMS_TEST_ZERO_OFFSET);
        assert(isUpToDate(response));
        expect(response.headers.get("stream-cursor")).toMatch(/^\d+$/);
        expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]+"$/);
        assert(response.headers.get("x-content-type-options") === "nosniff");
      });
    }, 5_000);

    it("advances a colliding cursor, including values beyond Number.MAX_SAFE_INTEGER", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        await appendTargetMutation();
        const previousCursor = "900719925474099312345";
        const response = await fetch(
          `${streamUrl}?offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll&cursor=${previousCursor}`,
        );

        const returnedCursor = response.headers.get("stream-cursor");
        expect(returnedCursor).toMatch(/^\d+$/);
        expect(BigInt(returnedCursor as string)).toBeGreaterThan(BigInt(previousCursor));
      });
    });

    it("validates required, duplicate, and malformed live parameters", async () => {
      await withFixture(async ({ streamUrl }) => {
        const invalidQueries = [
          "live=long-poll",
          `offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll&live=long-poll`,
          `offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll&cursor=1&cursor=2`,
          `offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll&cursor=01`,
          `offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll&cursor=123abc`,
          `offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll&cursor=-1`,
        ];

        for (const query of invalidQueries) {
          const response = await fetch(`${streamUrl}?${query}`);
          assert(response.status === 400, query);
        }
      });
    });

    it("stops polling when the supplied handler signal is aborted", async () => {
      const controller = new AbortController();
      let listCalls = 0;
      const responsePromise = handleDurableStreamRequest({
        method: "GET",
        schema: { name: "alpha", namespace: "alpha" },
        query: new URLSearchParams({
          offset: DURABLE_STREAMS_TEST_ZERO_OFFSET,
          live: "long-poll",
        }),
        signal: controller.signal,
        listOutboxEntries: async () => {
          listCalls += 1;
          return [];
        },
        getTailOffset: async () => undefined,
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.abort();
      await expect(responsePromise).rejects.toMatchObject({ name: "AbortError" });
      const callsAfterAbort = listCalls;
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(listCalls).toBe(callsAfterAbort);
    });

    it("propagates an actual Node HTTP disconnect to the request signal", async () => {
      await withFixture(async ({ streamUrl, waitForRequestAbort }) => {
        const abortObserved = waitForRequestAbort();
        const request = httpRequest(
          `${streamUrl}?offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll`,
        );
        request.on("error", () => {});
        request.end();
        await new Promise((resolve) => setTimeout(resolve, 50));
        request.destroy();

        await within(abortObserved);
      });
    });
  });

  describe("conditional reads", () => {
    it("returns 304 for exact, weak, wildcard, and comma-list If-None-Match values", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        await appendTargetMutation("first");
        const firstResponse = await fetch(streamUrl);
        const firstEtag = firstResponse.headers.get("etag");
        expect(firstEtag).toMatch(/^"[0-9a-f]+"$/);

        for (const value of [
          firstEtag as string,
          `W/${firstEtag as string}`,
          `"wrong", ${firstEtag as string}`,
          "*",
        ]) {
          const response = await fetch(streamUrl, { headers: { "If-None-Match": value } });
          assert(response.status === 304, value);
          assert((await response.text()) === "");
        }

        await appendTargetMutation("second");
        const changedResponse = await fetch(streamUrl, {
          headers: { "If-None-Match": firstEtag as string },
        });
        assert(changedResponse.status === 200);
        expect(changedResponse.headers.get("etag")).not.toBe(firstEtag);
      });
    });
  });

  describe("standard TypeScript client", () => {
    it("reads catch-up data without implementation-specific knowledge", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        const expected = [];
        for (let index = 0; index < 10; index += 1) {
          expected.push((await appendTargetMutation(`client-${index}`)).versionstamp);
        }

        const response = await stream<Record<string, unknown>>({ url: streamUrl, live: false });
        const entries = await response.json();

        expect(entries.map((entry) => entry["versionstamp"])).toEqual(expected);
        expect(response.offset).toMatch(STREAM_OFFSET_PATTERN);
        assert(response.upToDate);
      });
    });

    it.skip("current latest upstream client 0.2.6 drops the final page when a partial response is prefetched", () => {});

    it("resumes from a server-minted offset", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        await appendTargetMutation("before-offset");
        const firstResponse = await fetch(streamUrl);
        const offset = nextOffset(firstResponse);
        await appendTargetMutation("after-offset");

        const response = await stream<Record<string, unknown>>({
          url: streamUrl,
          offset: offset as string,
          live: false,
        });
        const entries = await response.json();

        expect(entries).toHaveLength(1);
        expect(entries[0]?.["versionstamp"]).toBeTypeOf("string");
      });
    });

    it("transitions from offset=now catch-up to long-poll and can be cancelled", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutation }) => {
        const response = await stream<Record<string, unknown>>({
          url: streamUrl,
          offset: "now",
          live: true,
        });
        const received = new Promise<string>((resolve) => {
          const unsubscribe = response.subscribeJson(async (batch) => {
            const versionstamp = batch.items[0]?.["versionstamp"];
            if (typeof versionstamp === "string") {
              unsubscribe();
              resolve(versionstamp);
            }
          });
        });

        await new Promise((resolve) => setTimeout(resolve, 50));
        const appended = await appendTargetMutation("client-live");

        await expect(within(received)).resolves.toBe(appended.versionstamp);
        await within(response.closed);
      });
    });
  });

  describe.each(["kysely-sqlite", "kysely-pglite"] as const)(
    "persistent adapter: %s",
    (adapter) => {
      it("supports HEAD, catch-up, resumption, and immediate long-poll over real HTTP", async () => {
        await withFixture(
          async ({ streamUrl, appendTargetMutation }) => {
            const first = await appendTargetMutation(`${adapter}-first`);
            const firstResponse = await fetch(streamUrl);
            expect((await readEntries(firstResponse))[0]?.["versionstamp"]).toBe(
              first.versionstamp,
            );
            const offset = nextOffset(firstResponse);
            expect(offset).toMatch(STREAM_OFFSET_PATTERN);

            const second = await appendTargetMutation(`${adapter}-second`);
            const resumed = await fetch(`${streamUrl}?offset=${offset as string}`);
            expect((await readEntries(resumed))[0]?.["versionstamp"]).toBe(second.versionstamp);

            const head = await fetch(streamUrl, { method: "HEAD" });
            expect(nextOffset(head)).toBe(nextOffset(resumed));

            const longPoll = await fetch(
              `${streamUrl}?offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll`,
            );
            assert(longPoll.status === 200);
            expect(await readEntries(longPoll)).toHaveLength(2);
          },
          { adapter },
        );
      }, 20_000);
    },
  );

  describe("concurrent readers and writers", () => {
    it("returns complete ordered entries to concurrent readers during concurrent commits", async () => {
      await withFixture(async ({ streamUrl, appendTargetMutationsConcurrently }) => {
        const longPolls = Array.from({ length: 5 }, () =>
          fetch(`${streamUrl}?offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=long-poll`),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));

        const committedEntries = await appendTargetMutationsConcurrently(10);
        expect(committedEntries).toHaveLength(10);
        const committedVersionstamps = committedEntries.map((entry) => entry.versionstamp);
        expect([...committedVersionstamps].sort()).toEqual(committedVersionstamps);
        expect(new Set(committedVersionstamps).size).toBe(committedVersionstamps.length);

        const liveResponses = await Promise.all(longPolls);
        for (const response of liveResponses) {
          assert(response.status === 200);
          const observed = (await readEntries(response)).map(
            (entry) => entry["versionstamp"] as string,
          );
          expect(observed.length).toBeGreaterThan(0);
          expect(committedVersionstamps.slice(0, observed.length)).toEqual(observed);
        }

        const readerResponses = await Promise.all(
          Array.from({ length: 7 }, () => fetch(streamUrl)),
        );
        for (const response of readerResponses) {
          expect((await readEntries(response)).map((entry) => entry["versionstamp"])).toEqual(
            committedVersionstamps,
          );
        }
      });
    });
  });

  describe("restart durability", () => {
    it("keeps messages and server-minted offsets valid after a PGlite restart", async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "fragno-durable-streams-"));
      try {
        let persistedOffset: string | null = null;
        let persistedVersionstamp: string | undefined;
        await withFixture(
          async ({ streamUrl, appendTargetMutation }) => {
            persistedVersionstamp = (await appendTargetMutation("before-restart")).versionstamp;
            const response = await fetch(streamUrl);
            persistedOffset = nextOffset(response);
            expect(persistedOffset).toMatch(STREAM_OFFSET_PATTERN);
          },
          { adapter: "kysely-pglite", pgliteDataDir: dataDir },
        );

        await withFixture(
          async ({ streamUrl }) => {
            const replay = await fetch(streamUrl);
            expect((await readEntries(replay))[0]?.["versionstamp"]).toBe(persistedVersionstamp);

            const resumed = await fetch(`${streamUrl}?offset=${persistedOffset as string}`);
            expect(await readEntries(resumed)).toEqual([]);
            expect(nextOffset(resumed)).toBe(persistedOffset);
            assert(isUpToDate(resumed));
          },
          { adapter: "kysely-pglite", pgliteDataDir: dataDir, skipMigrations: true },
        );
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }, 30_000);
  });

  describe("errors, CORS, and unsupported modes", () => {
    it("returns secured 404 responses for unknown schema streams", async () => {
      await withFixture(async ({ streamUrlFor }) => {
        const response = await fetch(streamUrlFor("unknown-schema"));
        assert(response.status === 404);
        assert(response.headers.get("x-content-type-options") === "nosniff");
        assert(response.headers.get("cross-origin-resource-policy") === "cross-origin");
      });
    });

    it("returns a complete conditional-GET CORS preflight response", async () => {
      await withFixture(async ({ streamUrlFor }) => {
        const response = await fetch(streamUrlFor("arbitrary-preflight-path"), {
          method: "OPTIONS",
          headers: {
            Origin: "https://example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "if-none-match",
          },
        });

        assert(response.status === 204);
        assert(response.headers.get("access-control-allow-origin") === "*");
        expect(response.headers.get("access-control-allow-methods")).toContain("GET");
        expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
          "if-none-match",
        );
      });
    });

    it("returns 405 with Allow for writes to existing read-only stream URLs", async () => {
      await withFixture(async ({ streamUrl, streamUrlFor }) => {
        for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
          const response = await fetch(streamUrl, { method });
          assert(response.status === 405, method);
          assert(response.headers.get("allow") === "GET, HEAD, OPTIONS");
          assert(response.headers.get("x-content-type-options") === "nosniff");
        }

        const unknownResponse = await fetch(streamUrlFor("unknown"), { method: "POST" });
        assert(unknownResponse.status === 404);
      });
    });

    it("rejects unsupported live modes instead of silently falling back", async () => {
      await withFixture(async ({ streamUrl }) => {
        for (const liveMode of ["sse", "unknown"]) {
          const response = await fetch(
            `${streamUrl}?offset=${DURABLE_STREAMS_TEST_ZERO_OFFSET}&live=${liveMode}`,
          );
          assert(response.status === 400);
        }
      });
    });
  });

  describe("features intentionally deferred", () => {
    it.todo("streams data and control events with live=sse");
    it.skip("not applicable: reports Stream-Closed for externally closed finite streams", () => {});
  });
});
