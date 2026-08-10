import { assert, describe, expect, it, vi } from "vitest";

import { FragnoId } from "@fragno-dev/db/schema";
import superjson from "superjson";

import type { OutboxEntry, OutboxPayload } from "@fragno-dev/db";

import type { LofiAdapter, LofiSubmitCommand } from "../types";
import { rebaseSubmitQueue } from "./rebase";

const makePayload = (versionstamp: string): OutboxPayload => ({
  version: 2,
  operations: [
    {
      op: "update",
      schema: "app",
      table: "users",
      externalId: "user-1",
      versionstamp: `mutation-${versionstamp}`,
      set: { name: "Bea" },
    },
  ],
});

const makeEntry = (versionstamp: string): OutboxEntry => ({
  id: FragnoId.fromExternal(`entry-${versionstamp}`, 1),
  versionstamp,
  uowId: `uow-${versionstamp}`,
  payload: superjson.serialize(makePayload(versionstamp)),
  createdAt: new Date(),
});

describe("rebaseSubmitQueue", () => {
  it("applies truncate IDs before advancing the rebase cursor", async () => {
    const meta = new Map<string, string>();
    const applyOutboxEntry = vi.fn(async () => ({ applied: true }));
    const adapter: LofiAdapter = {
      applyOutboxEntry,
      getMeta: async (key) => meta.get(key),
      setMeta: async (key, value) => {
        meta.set(key, value);
      },
    };
    const entry = makeEntry("vs-1");
    entry.payload = superjson.serialize({
      version: 2,
      operations: [
        {
          op: "truncate",
          schema: "app",
          table: "users",
          match: { teamId: "team-1" },
          externalIds: ["user-1", "user-2"],
          versionstamp: "mutation-vs-1",
        },
      ],
    } satisfies OutboxPayload);

    await rebaseSubmitQueue({
      adapter,
      entries: [entry],
      cursorKey: "client-a::outbox",
      confirmedCommandIds: [],
      queue: [],
    });

    expect(applyOutboxEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        mutations: [
          expect.objectContaining({ op: "delete", externalId: "user-1" }),
          expect.objectContaining({ op: "delete", externalId: "user-2" }),
        ],
      }),
    );
    assert(meta.get("client-a::outbox") === "vs-1");
  });

  it("removes confirmed commands after applying server entries", async () => {
    const meta = new Map<string, string>();
    const adapter: LofiAdapter = {
      applyOutboxEntry: vi.fn(async () => ({ applied: true })),
      getMeta: async (key) => meta.get(key),
      setMeta: async (key, value) => {
        meta.set(key, value);
      },
    };

    const queue: LofiSubmitCommand[] = [
      {
        id: "cmd-1",
        name: "renameUser",
        target: { fragment: "app", schema: "app" },
        input: { id: "user-1", name: "Bea" },
      },
    ];

    const result = await rebaseSubmitQueue({
      adapter,
      entries: [makeEntry("vs-1")],
      cursorKey: "client-a::outbox",
      confirmedCommandIds: ["cmd-1"],
      queue,
    });

    expect(adapter.applyOutboxEntry).toHaveBeenCalledTimes(1);
    expect(result.queue).toEqual([]);
  });
});
