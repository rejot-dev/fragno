import { assert, expect, test } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LocalDurableObjectNamespace,
  ProcessLocalObjectExecutionCoordinator,
} from "./local-durable-objects";
import { SqliteDurableObjectState } from "./sqlite-durable-object-state";
import { SqliteObjectCoordination } from "./sqlite-object-coordination";
import { SqliteBackofficeObjectStorage } from "./sqlite-object-storage";

type TestObject = {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
};

function createSqliteObjectTestRuntime(directory: string, recordAlarm: () => void) {
  const storage = new SqliteBackofficeObjectStorage(directory);
  const coordination = new SqliteObjectCoordination(storage);
  const namespace = new LocalDurableObjectNamespace<TestObject>({
    name: "TEST",
    executionCoordinator: new ProcessLocalObjectExecutionCoordinator(),
    createState: (id) => new SqliteDurableObjectState(id, storage, coordination),
    createObject: ({ state }) => ({
      async fetch(request) {
        if (new URL(request.url).pathname === "/schedule") {
          await state.storage.put("message", "shared through SQLite");
          await state.storage.setAlarm(Date.now() - 1);
          return new Response(null, { status: 204 });
        }
        return Response.json({
          message: await state.storage.get("message"),
          processed: (await state.storage.get("processed")) ?? false,
        });
      },
      async alarm() {
        recordAlarm();
        await state.storage.put("processed", true);
      },
    }),
  });

  return {
    object(name: string): TestObject {
      return namespace.get(namespace.idFromName(name));
    },
    async discoverPersistedObjects(): Promise<void> {
      for (const objectId of storage.objectIds()) {
        const [binding, ...nameParts] = objectId.split(":");
        if (binding === "TEST" && nameParts.length > 0) {
          await namespace.discoverPersisted(namespace.idFromName(nameParts.join(":")));
        }
      }
    },
    async drainAlarms(): Promise<void> {
      const now = Date.now();
      await Promise.all(
        namespace.instances().map(async (instance) => {
          const alarm = instance.state.dueAlarm(now);
          if (alarm) {
            await namespace.deliverAlarm(instance, alarm, now);
          }
        }),
      );
    },
    async cleanup(): Promise<void> {
      await coordination.waitForIdle();
      storage.close();
    },
  };
}

test("separate local object runtimes communicate through SQLite state and alarms", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-node-runtime-"));
  let alarmCalls = 0;
  const foreground = createSqliteObjectTestRuntime(directory, () => {
    alarmCalls += 1;
  });
  const firstProcessor = createSqliteObjectTestRuntime(directory, () => {
    alarmCalls += 1;
  });
  const secondProcessor = createSqliteObjectTestRuntime(directory, () => {
    alarmCalls += 1;
  });

  try {
    const objectName = "v1:org:org-1";
    const scheduled = await foreground
      .object(objectName)
      .fetch(new Request("https://backoffice.example/schedule"));
    assert.equal(scheduled.status, 204);

    await Promise.all([
      firstProcessor.discoverPersistedObjects(),
      secondProcessor.discoverPersistedObjects(),
    ]);
    await Promise.all([firstProcessor.drainAlarms(), secondProcessor.drainAlarms()]);

    const state = await foreground
      .object(objectName)
      .fetch(new Request("https://backoffice.example/state"));
    expect(await state.json()).toEqual({
      message: "shared through SQLite",
      processed: true,
    });
    assert.equal(alarmCalls, 1);
  } finally {
    await Promise.all([foreground.cleanup(), firstProcessor.cleanup(), secondProcessor.cleanup()]);
    await rm(directory, { recursive: true, force: true });
  }
});
