import { describe, expect, it, vi } from "vitest";
import superjson from "superjson";
import type { OutboxEntry, OutboxPayload } from "@fragno-dev/db";
import { FragnoId } from "@fragno-dev/db/schema";
import type { LofiAdapter, LofiSubmitCommand } from "../types";
import { rebaseSubmitQueue } from "./rebase";

const makePayload = (versionstamp: string): OutboxPayload => ({
  version: 1,
  mutations: [
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
  it.todo("does not replay confirmed commands after applying server entries", async () => {
    const meta = new Map<string, string>();
    const adapter: LofiAdapter = {
      applyOutboxEntry: vi.fn(async () => ({ applied: true })),
      getMeta: async (key) => meta.get(key),
      setMeta: async (key, value) => {
        meta.set(key, value);
      },
    };

    const replayCommand = vi.fn(async () => undefined);
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
      replayCommand,
    });

    expect(replayCommand).not.toHaveBeenCalled();
    expect(result.queue).toEqual([]);
  });
});
