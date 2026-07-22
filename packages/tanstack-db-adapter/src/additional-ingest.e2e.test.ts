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

const resumeSchema = schema("resume", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .addColumn("email", column("string")),
    )
    .addTable("posts", (t) => t.addColumn("id", idColumn()).addColumn("title", column("string"))),
);

const steps = createIngestScenarioSteps<typeof resumeSchema, "users">();

type ResumeContext = IngestScenarioContext<typeof resumeSchema, "users">;
type ResumeStep = IngestScenarioStep<typeof resumeSchema, "users">;
type ResumeServer = ResumeContext["server"];
type ResumeFactory = IngestScenarioCollectionOptionsFactory<typeof resumeSchema, "users">;

type User = {
  id: string;
  name: string;
  email: string;
};

const createCollectionOptions: ResumeFactory = ({ id, coordinator, target }) =>
  fragnoCollectionOptions({
    id,
    coordinator,
    target,
  });

function createCoordinatorFactory(options?: {
  pageSize?: number;
  requests?: string[];
}): IngestScenarioCoordinatorFactory {
  return ({ internalUrl, fetch }) =>
    createFragnoOutboxCoordinator({
      internalUrl,
      transport: createFetchFragnoOutboxTransport({
        internalUrl,
        fetch: options?.requests
          ? async (input, init) => {
              const url = String(input);
              if (new URL(url).pathname.endsWith("/outbox")) {
                options.requests?.push(url);
              }
              return fetch(input, init);
            }
          : fetch,
      }),
      pageSize: options?.pageSize,
      pollIntervalMs: 60_000,
    });
}

async function createUsers(server: ResumeServer, users: User[]): Promise<void> {
  await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        const mutations = forSchema(resumeSchema);
        for (const user of users) {
          mutations.create("users", user);
        }
      })
      .execute();
  });
}

async function createPost(
  server: ResumeServer,
  post: { id: string; title: string },
): Promise<void> {
  await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => forSchema(resumeSchema).create("posts", post))
      .execute();
  });
}

async function updateUser(
  server: ResumeServer,
  id: string,
  values: Partial<Pick<User, "name" | "email">>,
): Promise<void> {
  await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) =>
        forSchema(resumeSchema).update("users", id, (update) => update.set(values)),
      )
      .execute();
  });
}

async function deleteUsers(server: ResumeServer, ids: string[]): Promise<void> {
  await server.fragment.fragment.inContext(async function (this: DatabaseRequestContext) {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        const mutations = forSchema(resumeSchema);
        for (const id of ids) {
          mutations.delete("users", id);
        }
      })
      .execute();
  });
}

async function runResumeScenario(options: {
  name: string;
  steps: ResumeStep[];
  coordinator?: IngestScenarioCoordinatorFactory;
}): Promise<void> {
  const context = await runIngestScenario(
    defineIngestScenario({
      name: options.name,
      schema: resumeSchema,
      table: "users",
      collectionOptions: createCollectionOptions,
      ...(options.coordinator ? { coordinator: options.coordinator } : {}),
      steps: options.steps,
    }),
  );
  await context.cleanup();
}

function domainUsers(context: ResumeContext): User[] {
  return [...context.frontend.collection.values()]
    .map(({ id, name, email }) => ({ id, name, email }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

describe("Fragno outbox resume behavior", () => {
  it("hydrates without a request and explicitly ingests from the persisted checkpoint", async () => {
    const requests: string[] = [];
    let persistedCheckpoint: FragnoOutboxCheckpoint | undefined;
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };

    await runResumeScenario({
      name: "resume-request-checkpoint",
      coordinator: createCoordinatorFactory({ requests }),
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.assert(({ frontend }) => {
          persistedCheckpoint = frontend.collection.utils.getCheckpoint();
          assert(persistedCheckpoint);
          requests.length = 0;
        }),
        steps.reload(),
        steps.assert(() => {
          expect(requests).toEqual([]);
        }),
        steps.ingest(),
        steps.assert(() => {
          expect(requests).toHaveLength(1);
          expect(new URL(requests[0]).searchParams.get("afterVersionstamp")).toBe(
            persistedCheckpoint?.versionstamp,
          );
        }),
      ],
    });
  });

  it("continues create, update, and delete ingestion after reload", async () => {
    const first = { id: "user-1", name: "Ada", email: "ada@example.com" };
    const second = { id: "user-2", name: "Grace", email: "grace@example.com" };
    const third = { id: "user-3", name: "Linus", email: "linus@example.com" };

    await runResumeScenario({
      name: "mutations-after-reload",
      steps: [
        steps.server(({ server }) => createUsers(server, [first, second])),
        steps.ingest(),
        steps.reload(),
        steps.server(async ({ server }) => {
          await updateUser(server, first.id, { name: "Ada Lovelace" });
          await deleteUsers(server, [second.id]);
          await createUsers(server, [third]);
        }),
        steps.ingest(),
        steps.assert((context) => {
          expect(domainUsers(context)).toEqual([{ ...first, name: "Ada Lovelace" }, third]);
        }),
        steps.reload(),
        steps.assert((context) => {
          expect(domainUsers(context)).toEqual([{ ...first, name: "Ada Lovelace" }, third]);
        }),
      ],
    });
  });

  it("does not replay old rows when explicitly syncing after reload", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };
    let checkpoint: FragnoOutboxCheckpoint | undefined;

    await runResumeScenario({
      name: "no-replay-after-reload",
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.reload(),
        steps.assert(({ frontend }) => {
          checkpoint = frontend.collection.utils.getCheckpoint();
        }),
        steps.ingest(),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          expect(frontend.collection.utils.getCheckpoint()).toEqual(checkpoint);
          expect(frontend.collection.get(user.id)).toMatchObject(user);
          await expect(frontend.readPersistedRows()).resolves.toHaveLength(1);
        }),
      ],
    });
  });
});

describe("Fragno outbox scale and page boundaries", () => {
  it("applies one hundred mutations from a single outbox entry", async () => {
    const users = Array.from({ length: 100 }, (_, index) => ({
      id: `user-${String(index).padStart(3, "0")}`,
      name: `User ${index}`,
      email: `user-${index}@example.com`,
    }));

    await runResumeScenario({
      name: "hundred-mutations-one-entry",
      steps: [
        steps.server(({ server }) => createUsers(server, users)),
        steps.ingest(),
        steps.assert(async (context) => {
          expect(domainUsers(context)).toEqual(users);
          await expect(context.frontend.readPersistedRows()).resolves.toHaveLength(100);
        }),
      ],
    });
  });

  it("drains many entries across uneven page boundaries", async () => {
    const users = Array.from({ length: 25 }, (_, index) => ({
      id: `user-${String(index).padStart(2, "0")}`,
      name: `User ${index}`,
      email: `user-${index}@example.com`,
    }));
    const requests: string[] = [];

    await runResumeScenario({
      name: "uneven-page-boundaries",
      coordinator: createCoordinatorFactory({ pageSize: 7, requests }),
      steps: [
        ...users.map((user) => steps.server(({ server }) => createUsers(server, [user]))),
        steps.ingest(),
        steps.assert(async (context) => {
          expect(domainUsers(context)).toEqual(users);
          expect(requests).toHaveLength(4);
          await expect(context.frontend.readPersistedRows()).resolves.toHaveLength(25);
        }),
      ],
    });
  });

  it("advances through unrelated pages before reaching a target entry", async () => {
    const requests: string[] = [];
    const user = { id: "shared-id", name: "Ada", email: "ada@example.com" };

    await runResumeScenario({
      name: "unrelated-pages-before-target",
      coordinator: createCoordinatorFactory({ pageSize: 1, requests }),
      steps: [
        steps.server(({ server }) => createPost(server, { id: "post-1", title: "First" })),
        steps.server(({ server }) => createPost(server, { id: "shared-id", title: "Same ID" })),
        steps.server(({ server }) => createUsers(server, [user])),
        steps.server(({ server }) => createPost(server, { id: "post-3", title: "Last" })),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          expect(frontend.collection.get(user.id)).toMatchObject(user);
          await expect(frontend.readPersistedRows()).resolves.toHaveLength(1);
          expect(requests).toHaveLength(5);
          expect(frontend.collection.utils.getCheckpoint()).toMatchObject({
            versionstamp: expect.any(String),
            uowId: expect.any(String),
          });
        }),
      ],
    });
  });
});

describe("Fragno outbox checkpoint and row metadata progression", () => {
  it("advances row and collection metadata for an update that keeps the same values", async () => {
    const user = { id: "user-1", name: "Ada", email: "ada@example.com" };
    let insertCheckpoint: FragnoOutboxCheckpoint | undefined;
    let insertRowMetadata: unknown;

    await runResumeScenario({
      name: "same-value-update",
      steps: [
        steps.server(({ server }) => createUsers(server, [user])),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          insertCheckpoint = frontend.collection.utils.getCheckpoint();
          [insertRowMetadata] = (await frontend.readPersistedRows()).map(
            ({ metadata }) => metadata,
          );
        }),
        steps.server(({ server }) => updateUser(server, user.id, { name: user.name })),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          const updateCheckpoint = frontend.collection.utils.getCheckpoint();
          assert(insertCheckpoint && updateCheckpoint);
          assert(updateCheckpoint.versionstamp > insertCheckpoint.versionstamp);
          expect(frontend.collection.get(user.id)).toMatchObject(user);
          const [persistedRow] = await frontend.readPersistedRows();
          expect(persistedRow.metadata).not.toEqual(insertRowMetadata);
          expect(persistedRow.metadata).toMatchObject({
            versionstamp: updateCheckpoint.versionstamp,
          });
        }),
      ],
    });
  });

  it("advances the checkpoint across a multi-row delete transaction", async () => {
    const users = [
      { id: "user-1", name: "Ada", email: "ada@example.com" },
      { id: "user-2", name: "Grace", email: "grace@example.com" },
      { id: "user-3", name: "Linus", email: "linus@example.com" },
    ];
    let insertCheckpoint: FragnoOutboxCheckpoint | undefined;

    await runResumeScenario({
      name: "multi-delete-checkpoint",
      steps: [
        steps.server(({ server }) => createUsers(server, users)),
        steps.ingest(),
        steps.assert(({ frontend }) => {
          insertCheckpoint = frontend.collection.utils.getCheckpoint();
        }),
        steps.server(({ server }) =>
          deleteUsers(
            server,
            users.map(({ id }) => id),
          ),
        ),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          const deleteCheckpoint = frontend.collection.utils.getCheckpoint();
          assert(insertCheckpoint && deleteCheckpoint);
          assert(deleteCheckpoint.versionstamp > insertCheckpoint.versionstamp);
          expect([...frontend.collection.values()]).toEqual([]);
          await expect(frontend.readPersistedRows()).resolves.toEqual([]);
          await expect(frontend.readPersistedMetadata()).resolves.toContainEqual({
            key: FRAGNO_OUTBOX_CHECKPOINT_METADATA_KEY,
            value: frontend.collection.utils.getCheckpoint(),
          });
        }),
      ],
    });
  });

  it("stores one shared provenance record for rows changed by the same unit of work", async () => {
    const users = [
      { id: "user-1", name: "Ada", email: "ada@example.com" },
      { id: "user-2", name: "Grace", email: "grace@example.com" },
    ];

    await runResumeScenario({
      name: "shared-uow-provenance",
      steps: [
        steps.server(({ server }) => createUsers(server, users)),
        steps.ingest(),
        steps.assert(async ({ frontend }) => {
          const checkpoint = frontend.collection.utils.getCheckpoint();
          assert(checkpoint);
          const persistedRows = await frontend.readPersistedRows();
          expect(persistedRows).toHaveLength(2);
          const metadata = persistedRows.map((row) => row.metadata);
          expect(metadata[0]).toEqual(metadata[1]);
          expect(metadata[0]).toMatchObject({
            versionstamp: checkpoint.versionstamp,
            uowId: expect.any(String),
          });
        }),
      ],
    });
  });
});
