import { describe, expect, it, assert } from "vitest";

import { column, idColumn, schema } from "@fragno-dev/db/schema";

import type { DatabaseRequestContext } from "@fragno-dev/db";

import { FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY, type FragnoOutboxCheckpoint } from "./checkpoint";
import { fragnoCollectionOptions } from "./collection-options";
import { createFragnoOutboxCoordinator } from "./coordinator";
import {
  createIngestScenarioSteps,
  defineIngestScenario,
  runIngestScenario,
  type IngestScenarioCollectionOptionsFactory,
  type IngestScenarioContext,
  type IngestScenarioCoordinatorFactory,
  type IngestScenarioStep,
} from "./scenario";
import { createFetchFragnoOutboxTransport } from "./transport";

const appSchema = schema("app", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string")),
    )
    .addTable("posts", (t) => t.addColumn("id", idColumn()).addColumn("title", column("string"))),
);

const steps = createIngestScenarioSteps<typeof appSchema, "users">();

type UsersCollectionOptionsFactory = IngestScenarioCollectionOptionsFactory<
  typeof appSchema,
  "users"
>;
type UsersScenarioContext = IngestScenarioContext<typeof appSchema, "users">;
type UsersScenarioStep = IngestScenarioStep<typeof appSchema, "users">;
type ScenarioServer = UsersScenarioContext["server"];

type UserInput = {
  id: string;
  name: string;
  email: string;
};

const createUsersCollectionOptions: UsersCollectionOptionsFactory = ({ id, coordinator, target }) =>
  fragnoCollectionOptions({
    id,
    coordinator,
    target,
  });

function createCoordinatorFactory(options?: {
  pageSize?: number;
  observeRequest?: (url: string) => void;
}): IngestScenarioCoordinatorFactory {
  return ({ internalUrl, fetch }) =>
    createFragnoOutboxCoordinator({
      internalUrl,
      transport: createFetchFragnoOutboxTransport({
        internalUrl,
        fetch: options?.observeRequest
          ? async (input, init) => {
              const url = String(input);
              if (new URL(url).pathname.endsWith("/outbox")) {
                options.observeRequest?.(url);
              }
              return fetch(input, init);
            }
          : fetch,
      }),
      pageSize: options?.pageSize,
      // E2E tests trigger syncOnce explicitly so background polling cannot race their assertions.
      pollIntervalMs: 60_000,
    });
}

async function createUsers(server: ScenarioServer, users: UserInput[]): Promise<void> {
  await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        const mutations = forSchema(appSchema);
        for (const user of users) {
          mutations.create("users", user);
        }
      })
      .execute();
  });
}

async function updateUser(
  server: ScenarioServer,
  userId: string,
  values: Partial<Pick<UserInput, "name" | "email">>,
): Promise<void> {
  await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) =>
        forSchema(appSchema).update("users", userId, (update) => update.set(values)),
      )
      .execute();
  });
}

async function updateUsers(
  server: ScenarioServer,
  updates: Array<{
    id: string;
    values: Partial<Pick<UserInput, "name" | "email">>;
  }>,
): Promise<void> {
  await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        const mutations = forSchema(appSchema);
        for (const update of updates) {
          mutations.update("users", update.id, (builder) => builder.set(update.values));
        }
      })
      .execute();
  });
}

async function deleteUsers(server: ScenarioServer, userIds: string[]): Promise<void> {
  await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        const mutations = forSchema(appSchema);
        for (const userId of userIds) {
          mutations.delete("users", userId);
        }
      })
      .execute();
  });
}

async function createPosts(
  server: ScenarioServer,
  posts: Array<{ id: string; title: string }>,
): Promise<void> {
  await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        const mutations = forSchema(appSchema);
        for (const post of posts) {
          mutations.create("posts", post);
        }
      })
      .execute();
  });
}

async function createUserAndPost(
  server: ScenarioServer,
  user: UserInput,
  post: { id: string; title: string },
): Promise<void> {
  await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        const mutations = forSchema(appSchema);
        mutations.create("users", user);
        mutations.create("posts", post);
      })
      .execute();
  });
}

async function runUsersScenario(options: {
  name: string;
  steps: UsersScenarioStep[];
  collectionOptions?: UsersCollectionOptionsFactory;
  coordinator?: IngestScenarioCoordinatorFactory;
  namespace?: string | null;
  databaseNamespace?: string | null;
}): Promise<void> {
  const context = await runIngestScenario(
    defineIngestScenario({
      name: options.name,
      schema: appSchema,
      table: "users",
      collectionOptions: options.collectionOptions ?? createUsersCollectionOptions,
      ...(options.coordinator ? { coordinator: options.coordinator } : {}),
      steps: options.steps,
      ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
      ...(options.databaseNamespace === undefined
        ? {}
        : { databaseNamespace: options.databaseNamespace }),
    }),
  );
  await context.cleanup();
}

function sortedCollectionRows(context: UsersScenarioContext): UserInput[] {
  return [...context.frontend.collection.values()]
    .map(({ id, name, email }) => ({ id, name, email }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

describe("Fragno outbox eager ingestion", () => {
  it("marks an empty collection ready without creating a checkpoint", async () => {
    await runUsersScenario({
      name: "empty-outbox",
      steps: [
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          assert(frontend.collection.status === "ready");
          expect([...frontend.collection.values()]).toEqual([]);
          expect(frontend.collection.utils.getCheckpoint()).toBeUndefined();
          await expect(frontend.readPersistedRows()).resolves.toEqual([]);
          await expect(frontend.readPersistedMetadata()).resolves.not.toContainEqual(
            expect.objectContaining({ key: FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY }),
          );
        }),
        steps.reload(),
        steps.assert(({ frontend }) => {
          assert(frontend.collection.status === "ready");
          expect([...frontend.collection.values()]).toEqual([]);
        }),
      ],
    });
  });

  it("persists an inserted row and hydrates it after reload", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };

    await runUsersScenario({
      name: "single-insert",
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject(user);
          await expect(frontend.readPersistedRows()).resolves.toEqual([
            expect.objectContaining({ key: user.id, value: user }),
          ]);
          await expect(frontend.readPersistedMetadata()).resolves.toContainEqual({
            key: FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY,
            value: frontend.collection.utils.getCheckpoint(),
          });
        }),
        steps.reload(),
        steps.assert(({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject(user);
        }),
      ],
    });
  });

  it("applies multiple inserts from one unit of work", async () => {
    const users = [
      { id: "user-1", name: "Ada", email: "ada@example.com" },
      { id: "user-2", name: "Grace", email: "grace@example.com" },
      { id: "user-3", name: "Linus", email: "linus@example.com" },
    ];

    await runUsersScenario({
      name: "multiple-inserts-one-uow",
      steps: [
        steps.server(({ server }) => createUsers(server, users)),
        steps.ingest(),
        steps.assert(async (context) => {
          expect(sortedCollectionRows(context)).toEqual(users);
          const persistedRows = await context.frontend.readPersistedRows();
          expect(persistedRows).toHaveLength(3);
          assert(new Set(persistedRows.map(({ metadata }) => JSON.stringify(metadata))).size === 1);
        }),
      ],
    });
  });

  it("drains every outbox page when the page size is one", async () => {
    const requestedUrls: string[] = [];
    const users = [
      { id: "user-1", name: "Ada", email: "ada@example.com" },
      { id: "user-2", name: "Grace", email: "grace@example.com" },
      { id: "user-3", name: "Linus", email: "linus@example.com" },
    ];

    await runUsersScenario({
      name: "page-size-one",
      coordinator: createCoordinatorFactory({
        pageSize: 1,
        observeRequest: (url) => requestedUrls.push(url),
      }),
      steps: [
        ...users.map((user) => steps.server(({ server }) => createUsers(server, [user]))),
        steps.ingest(),
        steps.assert((context) => {
          expect(sortedCollectionRows(context)).toEqual(users);
          expect(requestedUrls).toHaveLength(4);
          expect(requestedUrls.map((url) => new URL(url).searchParams.get("limit"))).toEqual([
            "1",
            "1",
            "1",
            "1",
          ]);
          expect(
            requestedUrls.map((url) => new URL(url).searchParams.get("afterVersionstamp")),
          ).toEqual([null, expect.any(String), expect.any(String), expect.any(String)]);
        }),
      ],
    });
  });

  it("does not duplicate rows or advance the checkpoint when syncing an unchanged outbox", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };
    let firstCheckpoint: FragnoOutboxCheckpoint | undefined;

    await runUsersScenario({
      name: "repeat-sync",
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.assert(({ frontend }) => {
          firstCheckpoint = frontend.collection.utils.getCheckpoint();
          expect(firstCheckpoint).toMatchObject({
            versionstamp: expect.any(String),
            uowId: expect.any(String),
          });
        }),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject(user);
          expect(frontend.collection.utils.getCheckpoint()).toEqual(firstCheckpoint);
          await expect(frontend.readPersistedRows()).resolves.toHaveLength(1);
        }),
      ],
    });
  });

  it("ingests entries written after the collection becomes ready", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };

    await runUsersScenario({
      name: "entry-after-ready",
      steps: [
        steps.ingest(),
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.assert(({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject(user);
        }),
      ],
    });
  });

  it("serializes concurrent explicit synchronization attempts", async () => {
    const users = [
      { id: "user-1", name: "Ada", email: "ada@example.com" },
      { id: "user-2", name: "Grace", email: "grace@example.com" },
    ];

    await runUsersScenario({
      name: "concurrent-sync-once",
      steps: [
        steps.ingest(),
        ...users.map((user) => steps.server(({ server }) => createUsers(server, [user]))),
        steps.assert(async (context) => {
          await Promise.all([
            context.frontend.collection.utils.syncOnce(),
            context.frontend.collection.utils.syncOnce(),
            context.frontend.collection.utils.syncOnce(),
          ]);
          expect(sortedCollectionRows(context)).toEqual(users);
        }),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          await expect(frontend.readPersistedRows()).resolves.toHaveLength(2);
        }),
      ],
    });
  });
});

describe("Fragno outbox updates and deletes", () => {
  it("applies partial updates without removing unchanged fields", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };

    await runUsersScenario({
      name: "partial-update",
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.server(({ server }) => updateUser(server, user.id, { name: "Grace" })),
        steps.ingest(),
        steps.assert(({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject({ ...user, name: "Grace" });
        }),
        steps.reload(),
        steps.assert(({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject({ ...user, name: "Grace" });
        }),
      ],
    });
  });

  it("applies successive updates in outbox order", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };

    await runUsersScenario({
      name: "successive-updates",
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.server(({ server }) => updateUser(server, user.id, { name: "Grace" })),
        steps.server(({ server }) =>
          updateUser(server, user.id, {
            name: "Margaret",
            email: "margaret@example.com",
          }),
        ),
        steps.ingest(),
        steps.assert(({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject({
            id: user.id,
            name: "Margaret",
            email: "margaret@example.com",
          });
        }),
      ],
    });
  });

  it("updates multiple rows from one unit of work", async () => {
    const users = [
      { id: "user-1", name: "Ada", email: "ada@example.com" },
      { id: "user-2", name: "Grace", email: "grace@example.com" },
    ];

    await runUsersScenario({
      name: "multiple-updates-one-uow",
      steps: [
        steps.server(({ server }) => createUsers(server, users)),
        steps.ingest(),
        steps.server(({ server }) =>
          updateUsers(server, [
            { id: "user-1", values: { name: "Ada Lovelace" } },
            { id: "user-2", values: { email: "hopper@example.com" } },
          ]),
        ),
        steps.ingest(),
        steps.assert((context) => {
          expect(sortedCollectionRows(context)).toEqual([
            { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
            { id: "user-2", name: "Grace", email: "hopper@example.com" },
          ]);
        }),
      ],
    });
  });

  it("deletes a row from memory and persisted storage", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };

    await runUsersScenario({
      name: "delete-row",
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.server(({ server }) => deleteUsers(server, [user.id])),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          assert(!frontend.collection.has(user.id));
          await expect(frontend.readPersistedRows()).resolves.toEqual([]);
        }),
        steps.reload(),
        steps.assert(({ frontend }) => {
          assert(!frontend.collection.has(user.id));
        }),
      ],
    });
  });

  it("deletes only the selected row from a multi-row collection", async () => {
    const users = [
      { id: "user-1", name: "Ada", email: "ada@example.com" },
      { id: "user-2", name: "Grace", email: "grace@example.com" },
    ];

    await runUsersScenario({
      name: "delete-one-row",
      steps: [
        steps.server(({ server }) => createUsers(server, users)),
        steps.ingest(),
        steps.server(({ server }) => deleteUsers(server, [users[0].id])),
        steps.ingest(),
        steps.assert((context) => {
          expect(sortedCollectionRows(context)).toEqual([users[1]]);
        }),
      ],
    });
  });

  it("materializes no row when create and delete are both caught up initially", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };

    await runUsersScenario({
      name: "create-then-delete-before-ingest",
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.server(({ server }) => deleteUsers(server, [user.id])),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          assert(!frontend.collection.has(user.id));
          await expect(frontend.readPersistedRows()).resolves.toEqual([]);
          expect(frontend.collection.utils.getCheckpoint()).toMatchObject({
            versionstamp: expect.any(String),
            uowId: expect.any(String),
          });
        }),
      ],
    });
  });
});

describe("Fragno outbox target filtering and checkpoints", () => {
  it("checkpoints entries for unrelated tables", async () => {
    let observedCheckpoint: FragnoOutboxCheckpoint | undefined;

    await runUsersScenario({
      name: "unrelated-table-checkpoint",
      steps: [
        steps.server(({ server }) => createPosts(server, [{ id: "post-1", title: "Unrelated" }])),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          observedCheckpoint = frontend.collection.utils.getCheckpoint();
          expect(observedCheckpoint).toMatchObject({
            versionstamp: expect.any(String),
            uowId: expect.any(String),
          });
          expect([...frontend.collection.values()]).toEqual([]);
          await expect(frontend.readPersistedRows()).resolves.toEqual([]);
          await expect(frontend.readPersistedMetadata()).resolves.toContainEqual({
            key: FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY,
            value: frontend.collection.utils.getCheckpoint(),
          });
        }),
        steps.reload(),
        steps.assert(({ frontend }) => {
          expect(frontend.collection.utils.getCheckpoint()).toEqual(observedCheckpoint);
          expect([...frontend.collection.values()]).toEqual([]);
        }),
      ],
    });
  });

  it("applies target mutations and ignores unrelated mutations in the same entry", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };

    await runUsersScenario({
      name: "mixed-table-entry",
      steps: [
        steps.server(({ server }) =>
          createUserAndPost(server, user, { id: "post-1", title: "Unrelated" }),
        ),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject(user);
          await expect(frontend.readPersistedRows()).resolves.toHaveLength(1);
        }),
      ],
    });
  });

  it("ignores a mismatched physical namespace while advancing the checkpoint", async () => {
    await runUsersScenario({
      name: "namespace-mismatch",
      databaseNamespace: "tenant-a",
      namespace: "tenant-b",
      steps: [
        steps.server(({ server }) =>
          createUsers(server, [{ id: "user-1", name: "Ada", email: "ada@example.com" }]),
        ),
        steps.ingest(),
        steps.assert(({ frontend }) => {
          expect([...frontend.collection.values()]).toEqual([]);
          expect(frontend.collection.utils.getCheckpoint()).toMatchObject({
            versionstamp: expect.any(String),
            uowId: expect.any(String),
          });
        }),
      ],
    });
  });

  it("matches a custom physical namespace", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };

    await runUsersScenario({
      name: "custom-namespace",
      databaseNamespace: "tenant-a",
      namespace: "tenant-a",
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.assert(({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject(user);
        }),
      ],
    });
  });

  it("matches the empty physical namespace", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };

    await runUsersScenario({
      name: "empty-namespace",
      databaseNamespace: null,
      namespace: null,
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.assert(({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject(user);
        }),
      ],
    });
  });
});

describe("Fragno row synchronization metadata", () => {
  it("persists the outbox provenance for an inserted row", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };

    await runUsersScenario({
      name: "insert-row-metadata",
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          const checkpoint = frontend.collection.utils.getCheckpoint();
          assert(checkpoint);
          const [persistedRow] = await frontend.readPersistedRows();
          expect(persistedRow).toMatchObject({
            key: user.id,
            metadata: {
              versionstamp: checkpoint.versionstamp,
              uowId: expect.any(String),
            },
          });
        }),
        steps.reload(),
        steps.assert(async ({ frontend }) => {
          const checkpoint = frontend.collection.utils.getCheckpoint();
          assert(checkpoint);
          const [persistedRow] = await frontend.readPersistedRows();
          expect(persistedRow.metadata).toMatchObject({
            versionstamp: checkpoint.versionstamp,
            uowId: expect.any(String),
          });
        }),
      ],
    });
  });

  it("replaces row provenance when a later update is applied", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };
    let insertMetadata: unknown;

    await runUsersScenario({
      name: "update-row-metadata",
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          [insertMetadata] = (await frontend.readPersistedRows()).map(({ metadata }) => metadata);
        }),
        steps.server(({ server }) => updateUser(server, user.id, { name: "Grace" })),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          const checkpoint = frontend.collection.utils.getCheckpoint();
          assert(checkpoint);
          const [persistedRow] = await frontend.readPersistedRows();
          expect(persistedRow.metadata).not.toEqual(insertMetadata);
          expect(persistedRow.metadata).toMatchObject({
            versionstamp: checkpoint.versionstamp,
            uowId: expect.any(String),
          });
        }),
      ],
    });
  });
});
