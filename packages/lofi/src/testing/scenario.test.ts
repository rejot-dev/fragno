import { beforeEach, describe, expect, it } from "vitest";
import {
  IDBCursor,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
} from "fake-indexeddb";
import { defineSyncCommands } from "@fragno-dev/db";
import { column, FragnoId, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import type { LofiSubmitCommandDefinition, LofiSyncCommandTxFactory } from "../types";
import type { ScenarioContext } from "./scenario";
import { defineScenario, runScenario, steps } from "./scenario";

const appSchema = schema("app", (s) =>
  s
    .addTable("users", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("name", column("string"))
        .createIndex("idx_name", ["name"]),
    )
    .addTable("posts", (t) =>
      t
        .addColumn("id", idColumn())
        .addColumn("authorId", referenceColumn())
        .addColumn("title", column("string"))
        .createIndex("idx_author", ["authorId"]),
    )
    .addReference("author", {
      type: "one",
      from: { table: "posts", column: "authorId" },
      to: { table: "users", column: "id" },
    }),
);

type ConditionBuilder = (column: string, op: string, value: unknown) => unknown;
type JoinBuilder = { author: () => unknown };
type FindBuilder = {
  whereIndex: (index: "primary", condition?: (eb: ConditionBuilder) => unknown) => FindBuilder;
  join: (joiner: (j: JoinBuilder) => unknown) => FindBuilder;
};
type CommandArgs = { input: unknown; tx: LofiSyncCommandTxFactory; ctx: unknown };
type QueryApi = {
  findFirst: (
    table: "users" | "posts",
    builder: (b: FindBuilder) => FindBuilder,
  ) => Promise<{ id: FragnoId; name?: string } | null>;
  find: (
    table: "posts",
    builder: (b: FindBuilder) => FindBuilder,
  ) => Promise<Array<{ title: string; author?: { name: string } | null }>>;
};
type AuthContext = { userId: string };

type CreateUserInput = { id: string; name: string };
const createUserHandler = async ({ input, tx }: CommandArgs) => {
  const payload = input as CreateUserInput;
  await tx()
    .mutate((ctx) => {
      ctx.forSchema(appSchema).create("users", { id: payload.id, name: payload.name });
    })
    .execute();
};

type UpdateUserInput = { id: string; name: string; expectedVersion: number };
const updateUserHandler = async ({ input, tx }: CommandArgs) => {
  const payload = input as UpdateUserInput;
  await tx()
    .mutate((ctx) => {
      ctx
        .forSchema(appSchema)
        .update("users", FragnoId.fromExternal(payload.id, payload.expectedVersion), (b) =>
          b.set({ name: payload.name }).check(),
        );
    })
    .execute();
};

type RenameUserInput = { id: string; name: string };
const renameUserHandler = async ({ input, tx }: CommandArgs) => {
  const payload = input as RenameUserInput;
  await tx()
    .mutate((ctx) => {
      ctx.forSchema(appSchema).update("users", payload.id, (b) => b.set({ name: payload.name }));
    })
    .execute();
};

type CreatePostInput = { id: string; authorId: string; title: string };
const createPostHandler = async ({ input, tx }: CommandArgs) => {
  const payload = input as CreatePostInput;
  await tx()
    .mutate((ctx) => {
      ctx.forSchema(appSchema).create("posts", {
        id: payload.id,
        title: payload.title,
        authorId: payload.authorId,
      });
    })
    .execute();
};

type RetitlePostInput = { postId: string; expectedAuthorName: string; title: string };
const retitlePostHandler = async ({ input, tx }: CommandArgs) => {
  const payload = input as RetitlePostInput;
  await tx()
    .retrieve((ctx) =>
      ctx
        .forSchema(appSchema)
        .findFirst("posts", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", payload.postId)).join((j) => j.author()),
        ),
    )
    .transformRetrieve(([post]) => post ?? null)
    .mutate((ctx) => {
      const { retrieveResult } = ctx;
      if (!retrieveResult || !retrieveResult.author) {
        return { updated: false };
      }
      if (retrieveResult.author.name !== payload.expectedAuthorName) {
        return { updated: false };
      }
      ctx
        .forSchema(appSchema)
        .update("posts", retrieveResult.id, (b) => b.set({ title: payload.title }).check());
      return { updated: true };
    })
    .execute();
};

type SecureRetitlePostInput = { postId: string; expectedAuthorName: string; title: string };
const secureRetitlePostHandler = async ({ input, tx, ctx }: CommandArgs) => {
  const payload = input as SecureRetitlePostInput;
  const auth = ctx as AuthContext;
  await tx()
    .retrieve((ctx) =>
      ctx
        .forSchema(appSchema)
        .findFirst("posts", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", payload.postId)).join((j) => j.author()),
        ),
    )
    .transformRetrieve(([post]) => post ?? null)
    .mutate((ctx) => {
      const { retrieveResult } = ctx;
      if (!retrieveResult || !retrieveResult.author) {
        return { updated: false };
      }
      if (retrieveResult.author.name !== payload.expectedAuthorName) {
        return { updated: false };
      }
      if (retrieveResult.author.id.externalId !== auth.userId) {
        return { updated: false };
      }
      ctx
        .forSchema(appSchema)
        .update("posts", retrieveResult.id, (b) => b.set({ title: payload.title }).check());
      return { updated: true };
    })
    .execute();
};

const syncCommands = defineSyncCommands({ schema: appSchema }).create(({ defineCommand }) => [
  defineCommand({ name: "createUser", handler: createUserHandler }),
  defineCommand({ name: "updateUser", handler: updateUserHandler }),
  defineCommand({ name: "renameUser", handler: renameUserHandler }),
  defineCommand({ name: "createPost", handler: createPostHandler }),
  defineCommand({ name: "retitlePost", handler: retitlePostHandler }),
  defineCommand({ name: "secureRetitlePost", handler: secureRetitlePostHandler }),
]);

const clientCommands: LofiSubmitCommandDefinition[] = [
  {
    name: "createUser",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: createUserHandler,
  },
  {
    name: "updateUser",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: updateUserHandler,
  },
  {
    name: "renameUser",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: renameUserHandler,
  },
  {
    name: "createPost",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: createPostHandler,
  },
  {
    name: "retitlePost",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: retitlePostHandler,
  },
  {
    name: "secureRetitlePost",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: secureRetitlePostHandler,
  },
];

describe("Lofi scenario DSL", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBCursor = IDBCursor;
    globalThis.IDBDatabase = IDBDatabase;
    globalThis.IDBIndex = IDBIndex;
    globalThis.IDBKeyRange = IDBKeyRange;
    globalThis.IDBObjectStore = IDBObjectStore;
    globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
    globalThis.IDBRequest = IDBRequest;
    globalThis.IDBTransaction = IDBTransaction;
  });

  it("keeps optimistic state while a conflicting command remains queued", async () => {
    const scenario = defineScenario({
      name: "conflict-rebase",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a" },
        b: { endpointName: "client-b" },
      },
      steps: [
        steps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        steps.read(
          "a",
          (_ctx, client) => {
            const query = client.query as QueryApi;
            return query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "userA",
        ),
        steps.sync("b"),
        steps.read(
          "b",
          (_ctx, client) => {
            const query = client.query as QueryApi;
            return query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "userB",
        ),
        steps.command(
          "b",
          "updateUser",
          (ctx: ScenarioContext) => ({
            id: "user-1",
            name: "Bea",
            expectedVersion: (ctx.vars["userB"] as { id: FragnoId }).id.version,
          }),
          { optimistic: true, submit: true },
        ),
        steps.command(
          "a",
          "updateUser",
          (ctx: ScenarioContext) => ({
            id: "user-1",
            name: "Aria",
            expectedVersion: (ctx.vars["userA"] as { id: FragnoId }).id.version,
          }),
          { optimistic: true, submit: true },
        ),
        steps.read(
          "a",
          (_ctx, client) => {
            const query = client.query as QueryApi;
            return query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "userAFinal",
        ),
        steps.assert((ctx: ScenarioContext) => {
          const response = ctx.lastSubmit["a"];
          expect(response?.status).toBe("conflict");
          if (response && response.status === "conflict") {
            expect(response.reason).toBe("write_congestion");
          }
          const user = ctx.vars["userAFinal"] as { name: string } | null;
          expect(user?.name).toBe("Aria");
        }),
      ],
    });

    const context = await runScenario(scenario);
    await context.cleanup();
  });

  it("does not reapply confirmed commands during submit rebase", async () => {
    const scenario = defineScenario({
      name: "rebase-confirmed",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a" },
      },
      steps: [
        steps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        steps.command(
          "a",
          "renameUser",
          { id: "user-1", name: "Bea" },
          { optimistic: true, submit: true },
        ),
        steps.read(
          "a",
          (_ctx, client) => {
            const query = client.query as QueryApi;
            return query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "user",
        ),
        steps.assert((ctx: ScenarioContext) => {
          const user = ctx.vars["user"] as { id: FragnoId } | null;
          expect(user?.id.version).toBe(2);
        }),
      ],
    });

    const context = await runScenario(scenario);
    await context.cleanup();
  });

  it("runs join-heavy commands and syncs derived state", async () => {
    const scenario = defineScenario({
      name: "join-commands",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a" },
        b: { endpointName: "client-b" },
      },
      steps: [
        steps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        steps.command(
          "a",
          "createPost",
          { id: "post-1", authorId: "user-1", title: "Hello" },
          { optimistic: true, submit: true },
        ),
        steps.command(
          "a",
          "retitlePost",
          { postId: "post-1", expectedAuthorName: "Ada", title: "Updated" },
          { optimistic: true, submit: true },
        ),
        steps.sync("b"),
        steps.read(
          "b",
          (_ctx, client) => {
            const query = client.query as QueryApi;
            return query.find("posts", (b) => b.whereIndex("primary").join((j) => j.author()));
          },
          "posts",
        ),
        steps.assert((ctx: ScenarioContext) => {
          const posts = ctx.vars["posts"] as Array<{
            title: string;
            author?: { name: string } | null;
          }>;
          expect(posts).toHaveLength(1);
          expect(posts[0]?.title).toBe("Updated");
          expect(posts[0]?.author?.name).toBe("Ada");
        }),
      ],
    });

    const context = await runScenario(scenario);
    await context.cleanup();
  });

  it("runs scenario steps against an HTTP server", async () => {
    const scenario = defineScenario({
      name: "http-server",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
        port: 0,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a" },
      },
      steps: [
        steps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        steps.sync("a"),
        steps.read(
          "a",
          (_ctx, client) => {
            const query = client.query as QueryApi;
            return query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "user",
        ),
        steps.assert((ctx: ScenarioContext) => {
          const response = ctx.lastSubmit["a"];
          expect(response?.status).toBe("applied");
          const user = ctx.vars["user"] as { name: string } | null;
          expect(user?.name).toBe("Ada");
        }),
      ],
    });

    const context = await runScenario(scenario);
    await context.cleanup();
  });

  it("enforces auth-scoped join commands", async () => {
    const scenario = defineScenario({
      name: "auth-join-scope",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a" },
        b: { endpointName: "client-b" },
      },
      createClientContext: (clientName) => ({
        userId: clientName === "a" ? "user-1" : "user-2",
      }),
      steps: [
        steps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        steps.command(
          "a",
          "createUser",
          { id: "user-2", name: "Bea" },
          { optimistic: true, submit: true },
        ),
        steps.command(
          "a",
          "createPost",
          { id: "post-1", authorId: "user-1", title: "Hello" },
          { optimistic: true, submit: true },
        ),
        steps.sync("b"),
        steps.command(
          "b",
          "secureRetitlePost",
          { postId: "post-1", expectedAuthorName: "Ada", title: "Denied" },
          { optimistic: true, submit: true },
        ),
        steps.read(
          "b",
          (_ctx, client) => {
            const query = client.query as QueryApi;
            return query.find("posts", (b) => b.whereIndex("primary").join((j) => j.author()));
          },
          "posts",
        ),
        steps.assert((ctx: ScenarioContext) => {
          const posts = ctx.vars["posts"] as Array<{
            title: string;
            author?: { name: string } | null;
          }>;
          expect(posts).toHaveLength(1);
          expect(posts[0]?.title).toBe("Hello");
          expect(posts[0]?.author?.name).toBe("Ada");
        }),
      ],
    });

    const context = await runScenario(scenario);
    await context.cleanup();
  });
});
