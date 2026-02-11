import { describe, expect, it } from "vitest";
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
import { ConcurrencyConflictError, defineSyncCommands } from "@fragno-dev/db";
import {
  column,
  FragnoId,
  FragnoReference,
  idColumn,
  referenceColumn,
  schema,
} from "@fragno-dev/db/schema";
import type { LofiSubmitCommandDefinition, LofiSyncCommandTxFactory } from "../types";
import { createScenarioSteps, defineScenario, runScenario } from "./scenario";
import type { ScenarioDefinition } from "./scenario";
import { StackedLofiAdapter } from "../adapters/stacked/adapter";

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

type CommandArgs = { input: unknown; tx: LofiSyncCommandTxFactory; ctx: unknown };
type AuthContext = { userId: string };
type ClientContext = { mode: "client" };
type UserRow = { id: FragnoId; name: string };
type PostWithAuthor = { title: string; author?: { name: string } | null };
type PostRow = { id: FragnoId; title: string; authorId: FragnoReference };
type ScenarioVars = {
  userA?: UserRow | null;
  userB?: UserRow | null;
  userAFinal?: UserRow | null;
  user?: UserRow | null;
  userFinal?: UserRow | null;
  retryUser?: UserRow | null;
  persistedUser?: UserRow | null;
  nonOptimisticUser?: UserRow | null;
  users?: UserRow[];
  baseUsers?: UserRow[];
  overlayUsers?: UserRow[];
  usersB?: UserRow[];
  posts?: PostWithAuthor[];
  stackedUser?: UserRow | null;
  baseUser?: UserRow | null;
  overlayUser?: UserRow | null;
  basePost?: PostRow | null;
  overlayPost?: PostRow | null;
};
const steps = createScenarioSteps<typeof appSchema, unknown, ScenarioVars>();
const authSteps = createScenarioSteps<typeof appSchema, AuthContext, ScenarioVars>();
const clientSteps = createScenarioSteps<typeof appSchema, ClientContext, ScenarioVars>();
const clientModeContext = () => ({ mode: "client" as const });

const createIndexedDbGlobals = () => ({
  indexedDB: new IDBFactory(),
  IDBCursor,
  IDBDatabase,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
});

const runScenarioWithIndexedDb = async <
  TSchema extends typeof appSchema,
  TContext = unknown,
  TCommands extends
    ReadonlyArray<LofiSubmitCommandDefinition> = ReadonlyArray<LofiSubmitCommandDefinition>,
  TVars extends ScenarioVars = ScenarioVars,
>(
  scenario: ScenarioDefinition<TSchema, TContext, TCommands, TVars>,
) => runScenario(scenario, { indexedDbGlobals: createIndexedDbGlobals() });

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
const updateUserHandler = async ({ input, tx, ctx }: CommandArgs) => {
  const payload = input as UpdateUserInput;
  const shouldCheck = (ctx as { mode?: string }).mode === "server";
  await tx()
    .mutate((ctx) => {
      ctx
        .forSchema(appSchema)
        .update("users", FragnoId.fromExternal(payload.id, payload.expectedVersion), (b) => {
          b.set({ name: payload.name });
          if (shouldCheck) {
            b.check();
          }
        });
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

const shouldConflictOnServer = (ctx: unknown): boolean =>
  (ctx as { mode?: string }).mode !== "client";

const renameUserConflictHandler = async ({ input, tx, ctx }: CommandArgs) => {
  const payload = input as RenameUserInput;
  if (shouldConflictOnServer(ctx)) {
    throw new ConcurrencyConflictError();
  }
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
          b.whereIndex("primary", (eb) => eb("id", "=", payload.postId)).join((j) => j["author"]()),
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
          b.whereIndex("primary", (eb) => eb("id", "=", payload.postId)).join((j) => j["author"]()),
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

type DeleteUserInput = { id: string; expectedVersion: number };
const deleteUserHandler = async ({ input, tx, ctx }: CommandArgs) => {
  const payload = input as DeleteUserInput;
  const shouldCheck = (ctx as { mode?: string }).mode === "server";
  await tx()
    .mutate((ctx) => {
      if (shouldCheck) {
        ctx
          .forSchema(appSchema)
          .delete("users", FragnoId.fromExternal(payload.id, payload.expectedVersion), (b) =>
            b.check(),
          );
        return;
      }
      ctx
        .forSchema(appSchema)
        .delete("users", FragnoId.fromExternal(payload.id, payload.expectedVersion));
    })
    .execute();
};

type DeleteUserConflictInput = { id: string };
const deleteUserConflictHandler = async ({ input, tx, ctx }: CommandArgs) => {
  const payload = input as DeleteUserConflictInput;
  if (shouldConflictOnServer(ctx)) {
    throw new ConcurrencyConflictError();
  }
  await tx()
    .mutate((ctx) => {
      ctx.forSchema(appSchema).delete("users", payload.id);
    })
    .execute();
};

type UpdateUserAndPostInput = {
  userId: string;
  userName: string;
  userExpectedVersion: number;
  postId: string;
  postTitle: string;
};
const updateUserAndPostHandler = async ({ input, tx, ctx }: CommandArgs) => {
  const payload = input as UpdateUserAndPostInput;
  const shouldCheck = (ctx as { mode?: string }).mode === "server";
  await tx()
    .mutate((ctx) => {
      ctx
        .forSchema(appSchema)
        .update(
          "users",
          FragnoId.fromExternal(payload.userId, payload.userExpectedVersion),
          (b) => {
            b.set({ name: payload.userName });
            if (shouldCheck) {
              b.check();
            }
          },
        );
      ctx
        .forSchema(appSchema)
        .update("posts", payload.postId, (b) => b.set({ title: payload.postTitle }));
    })
    .execute();
};

type UpdateUserAndPostConflictInput = {
  userId: string;
  userName: string;
  postId: string;
  postTitle: string;
};
const updateUserAndPostConflictHandler = async ({ input, tx, ctx }: CommandArgs) => {
  const payload = input as UpdateUserAndPostConflictInput;
  if (shouldConflictOnServer(ctx)) {
    throw new ConcurrencyConflictError();
  }
  await tx()
    .mutate((ctx) => {
      ctx
        .forSchema(appSchema)
        .update("users", payload.userId, (b) => b.set({ name: payload.userName }));
      ctx
        .forSchema(appSchema)
        .update("posts", payload.postId, (b) => b.set({ title: payload.postTitle }));
    })
    .execute();
};

const syncCommands = defineSyncCommands({ schema: appSchema }).create(({ defineCommand }) => [
  defineCommand({ name: "createUser", handler: createUserHandler }),
  defineCommand({ name: "updateUser", handler: updateUserHandler }),
  defineCommand({ name: "renameUser", handler: renameUserHandler }),
  defineCommand({ name: "renameUserConflict", handler: renameUserConflictHandler }),
  defineCommand({ name: "createPost", handler: createPostHandler }),
  defineCommand({ name: "retitlePost", handler: retitlePostHandler }),
  defineCommand({ name: "secureRetitlePost", handler: secureRetitlePostHandler }),
  defineCommand({ name: "deleteUser", handler: deleteUserHandler }),
  defineCommand({ name: "deleteUserConflict", handler: deleteUserConflictHandler }),
  defineCommand({ name: "updateUserAndPost", handler: updateUserAndPostHandler }),
  defineCommand({ name: "updateUserAndPostConflict", handler: updateUserAndPostConflictHandler }),
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
    name: "renameUserConflict",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: renameUserConflictHandler,
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
  {
    name: "deleteUser",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: deleteUserHandler,
  },
  {
    name: "deleteUserConflict",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: deleteUserConflictHandler,
  },
  {
    name: "updateUserAndPost",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: updateUserAndPostHandler,
  },
  {
    name: "updateUserAndPostConflict",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: updateUserAndPostConflictHandler,
  },
];

describe("Lofi scenario DSL", () => {
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
        a: { endpointName: "client-a", adapter: { type: "stacked" } },
        b: { endpointName: "client-b" },
      },
      createClientContext: clientModeContext,
      steps: [
        clientSteps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        clientSteps.read(
          "a",
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "userA",
        ),
        clientSteps.sync("b"),
        clientSteps.command(
          "b",
          "renameUser",
          { id: "user-1", name: "Bea" },
          { optimistic: true, submit: true },
        ),
        clientSteps.command(
          "a",
          "renameUserConflict",
          { id: "user-1", name: "Aria" },
          { optimistic: true, submit: true },
        ),
        clientSteps.read(
          "a",
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "userAFinal",
        ),
        clientSteps.assert((ctx) => {
          const response = ctx.lastSubmit["a"];
          expect(response?.status).toBe("conflict");
          if (response && response.status === "conflict") {
            expect(response.reason).toBe("write_congestion");
          }
          const user = ctx.vars.userAFinal;
          expect(user?.name).toBe("Aria");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
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
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "user",
        ),
        steps.assert((ctx) => {
          const user = ctx.vars.user;
          expect(user?.id.version).toBe(2);
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
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
          (_ctx, client) =>
            client.query.find("posts", (b) => b.whereIndex("primary").join((j) => j["author"]())),
          "posts",
        ),
        steps.assert((ctx) => {
          const posts = ctx.vars.posts;
          expect(posts).toHaveLength(1);
          expect(posts?.[0]?.title).toBe("Updated");
          expect(posts?.[0]?.author?.name).toBe("Ada");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
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
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "user",
        ),
        steps.assert((ctx) => {
          const response = ctx.lastSubmit["a"];
          expect(response?.status).toBe("applied");
          const user = ctx.vars.user;
          expect(user?.name).toBe("Ada");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("enforces auth-scoped join commands", async () => {
    const scenario = defineScenario<typeof appSchema, AuthContext>({
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
        authSteps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        authSteps.command(
          "a",
          "createUser",
          { id: "user-2", name: "Bea" },
          { optimistic: true, submit: true },
        ),
        authSteps.command(
          "a",
          "createPost",
          { id: "post-1", authorId: "user-1", title: "Hello" },
          { optimistic: true, submit: true },
        ),
        authSteps.sync("b"),
        authSteps.command(
          "b",
          "secureRetitlePost",
          { postId: "post-1", expectedAuthorName: "Ada", title: "Denied" },
          { optimistic: true, submit: true },
        ),
        authSteps.read(
          "b",
          (_ctx, client) =>
            client.query.find("posts", (b) => b.whereIndex("primary").join((j) => j["author"]())),
          "posts",
        ),
        authSteps.assert((ctx) => {
          const posts = ctx.vars.posts;
          expect(posts).toHaveLength(1);
          expect(posts?.[0]?.title).toBe("Hello");
          expect(posts?.[0]?.author?.name).toBe("Ada");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("supports stacked adapters with optimistic overlays", async () => {
    const scenario = defineScenario({
      name: "stacked-optimistic-overlay",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: {
          endpointName: "client-a",
          adapter: { type: "stacked" },
        },
      },
      steps: [
        steps.command("a", "createUser", { id: "user-1", name: "Ada" }, { optimistic: true }),
        steps.read(
          "a",
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "stackedUser",
        ),
        steps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "baseUser",
        ),
        steps.read(
          "a",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "overlayUser",
        ),
        steps.assert((ctx) => {
          const stackedUser = ctx.vars.stackedUser;
          const baseUser = ctx.vars.baseUser;
          const overlayUser = ctx.vars.overlayUser;
          expect(stackedUser?.name).toBe("Ada");
          expect(baseUser).toBeNull();
          expect(overlayUser?.name).toBe("Ada");
          const client = ctx.clients["a"];
          expect(client.adapters.stacked).toBeInstanceOf(StackedLofiAdapter);
          expect(client.stores.overlay).toBeDefined();
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("moves confirmed commands into base and clears overlay in stacked adapters", async () => {
    const scenario = defineScenario({
      name: "stacked-submit-clears-overlay",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: {
          endpointName: "client-a",
          adapter: { type: "stacked" },
        },
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
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "baseUser",
        ),
        steps.read(
          "a",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "overlayUser",
        ),
        steps.read(
          "a",
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "stackedUser",
        ),
        steps.assert((ctx) => {
          const baseUser = ctx.vars.baseUser;
          const overlayUser = ctx.vars.overlayUser;
          const stackedUser = ctx.vars.stackedUser;
          expect(baseUser?.name).toBe("Ada");
          expect(overlayUser).toBeNull();
          expect(stackedUser?.name).toBe("Ada");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("syncs confirmed optimistic writes across clients after a delay", async () => {
    const scenario = defineScenario({
      name: "stacked-multi-client-confirm-delay",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: {
          endpointName: "client-a",
          adapter: { type: "stacked" },
        },
        b: { endpointName: "client-b" },
      },
      steps: [
        steps.command("a", "createUser", { id: "user-1", name: "Ada" }, { optimistic: true }),
        steps.read(
          "a",
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "stackedUser",
        ),
        steps.submit("a"),
        steps.read(
          "a",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "overlayUser",
        ),
        steps.sync("b"),
        steps.read(
          "b",
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "userB",
        ),
        steps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "baseUser",
        ),
        steps.assert((ctx) => {
          expect(ctx.vars.stackedUser?.name).toBe("Ada");
          expect(ctx.vars.overlayUser).toBeNull();
          expect(ctx.vars.baseUser?.name).toBe("Ada");
          expect(ctx.vars.userB?.name).toBe("Ada");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("applies optimistic updates without mutating the base store", async () => {
    const scenario = defineScenario({
      name: "stacked-optimistic-update",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: {
          endpointName: "client-a",
          adapter: { type: "stacked", base: "in-memory" },
        },
      },
      steps: [
        steps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        steps.command("a", "renameUser", { id: "user-1", name: "Bea" }, { optimistic: true }),
        steps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "baseUser",
        ),
        steps.read(
          "a",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "overlayUser",
        ),
        steps.read(
          "a",
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "stackedUser",
        ),
        steps.assert((ctx) => {
          const baseUser = ctx.vars.baseUser;
          const overlayUser = ctx.vars.overlayUser;
          const stackedUser = ctx.vars.stackedUser;
          expect(baseUser?.name).toBe("Ada");
          expect(overlayUser?.name).toBe("Bea");
          expect(stackedUser?.name).toBe("Bea");

          const client = ctx.clients["a"];
          const baseStore = client.stores.base;
          const overlayStore = client.stores.overlay;
          expect(baseStore).toBeDefined();
          expect(overlayStore).toBeDefined();
          const baseRow = baseStore?.getRow(appSchema.name, "users", "user-1");
          const overlayRow = overlayStore?.getRow(appSchema.name, "users", "user-1");
          expect(baseRow?.data["name"]).toBe("Ada");
          expect(overlayRow?.data["name"]).toBe("Bea");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("handles concurrent optimistic edits with a conflict", async () => {
    const scenario = defineScenario({
      name: "concurrent-optimistic-conflict",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a", adapter: { type: "stacked" } },
        b: { endpointName: "client-b", adapter: { type: "stacked" } },
      },
      createClientContext: clientModeContext,
      steps: [
        clientSteps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        clientSteps.sync("b"),
        clientSteps.command(
          "a",
          "renameUser",
          { id: "user-1", name: "Aria" },
          { optimistic: true, submit: true },
        ),
        clientSteps.command(
          "b",
          "renameUserConflict",
          { id: "user-1", name: "Bea" },
          { optimistic: true },
        ),
        clientSteps.submit("b"),
        clientSteps.sync("b"),
        clientSteps.read(
          "a",
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "userAFinal",
        ),
        clientSteps.read(
          "b",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "baseUser",
        ),
        clientSteps.read(
          "b",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "overlayUser",
        ),
        clientSteps.assert((ctx) => {
          expect(ctx.lastSubmit["a"]?.status).toBe("applied");
          expect(ctx.lastSubmit["b"]?.status).toBe("conflict");
          expect(ctx.vars.userAFinal?.name).toBe("Aria");
          expect(ctx.vars.baseUser?.name).toBe("Aria");
          expect(ctx.vars.overlayUser?.name).toBe("Bea");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("replays offline queued optimistic commands on submit", async () => {
    const scenario = defineScenario({
      name: "offline-queue-submit",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a", adapter: { type: "stacked", base: "in-memory" } },
      },
      steps: [
        steps.command("a", "createUser", { id: "user-1", name: "Ada" }, { optimistic: true }),
        steps.command("a", "createUser", { id: "user-2", name: "Bea" }, { optimistic: true }),
        steps.read(
          "a",
          (_ctx, client) => client.query.find("users", (b) => b.whereIndex("primary")),
          "users",
        ),
        steps.read(
          "a",
          (_ctx, client) => client.baseQuery.find("users", (b) => b.whereIndex("primary")),
          "baseUsers",
        ),
        steps.read(
          "a",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.find("users", (b) => b.whereIndex("primary"));
          },
          "overlayUsers",
        ),
        steps.assert((ctx) => {
          expect(ctx.vars.users).toHaveLength(2);
          expect(ctx.vars.baseUsers).toHaveLength(0);
          expect(ctx.vars.overlayUsers).toHaveLength(2);
        }),
        steps.submit("a"),
        steps.read(
          "a",
          (_ctx, client) => client.baseQuery.find("users", (b) => b.whereIndex("primary")),
          "baseUsers",
        ),
        steps.read(
          "a",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.find("users", (b) => b.whereIndex("primary"));
          },
          "overlayUsers",
        ),
        steps.assert((ctx) => {
          expect(ctx.vars.baseUsers).toHaveLength(2);
          expect(ctx.vars.overlayUsers).toHaveLength(0);
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("keeps dependent optimistic commands after a conflict", async () => {
    const scenario = defineScenario({
      name: "conflict-keeps-dependent-optimistic",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a", adapter: { type: "stacked" } },
        b: { endpointName: "client-b" },
      },
      createClientContext: clientModeContext,
      steps: [
        clientSteps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        clientSteps.sync("b"),
        clientSteps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "userA",
        ),
        clientSteps.command(
          "b",
          "renameUser",
          { id: "user-1", name: "Bea" },
          { optimistic: true, submit: true },
        ),
        clientSteps.command(
          "a",
          "renameUserConflict",
          { id: "user-1", name: "Cora" },
          { optimistic: true },
        ),
        clientSteps.command(
          "a",
          "renameUser",
          { id: "user-1", name: "Dana" },
          { optimistic: true },
        ),
        clientSteps.submit("a"),
        clientSteps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "baseUser",
        ),
        clientSteps.read(
          "a",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "overlayUser",
        ),
        clientSteps.assert((ctx) => {
          expect(ctx.lastSubmit["a"]?.status).toBe("conflict");
          expect(ctx.vars.baseUser?.name).toBe("Bea");
          expect(ctx.vars.overlayUser?.name).toBe("Dana");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("detects delete vs update conflicts", async () => {
    const scenario = defineScenario({
      name: "delete-update-conflict",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a", adapter: { type: "stacked" } },
        b: { endpointName: "client-b" },
      },
      createClientContext: clientModeContext,
      steps: [
        clientSteps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        clientSteps.sync("b"),
        clientSteps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "userA",
        ),
        clientSteps.command(
          "b",
          "renameUser",
          { id: "user-1", name: "Bea" },
          { optimistic: true, submit: true },
        ),
        clientSteps.command(
          "a",
          "deleteUserConflict",
          { id: "user-1" },
          { optimistic: true, submit: true },
        ),
        clientSteps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "baseUser",
        ),
        clientSteps.assert((ctx) => {
          expect(ctx.lastSubmit["a"]?.status).toBe("conflict");
          expect(ctx.vars.baseUser?.name).toBe("Bea");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("keeps multi-entity optimistic changes after a conflict", async () => {
    const scenario = defineScenario({
      name: "multi-entity-conflict",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a", adapter: { type: "stacked" } },
        b: { endpointName: "client-b" },
      },
      createClientContext: clientModeContext,
      steps: [
        clientSteps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        clientSteps.command(
          "a",
          "createPost",
          { id: "post-1", authorId: "user-1", title: "Hello" },
          { optimistic: true, submit: true },
        ),
        clientSteps.sync("b"),
        clientSteps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "userA",
        ),
        clientSteps.command(
          "b",
          "renameUser",
          { id: "user-1", name: "Bea" },
          { optimistic: true, submit: true },
        ),
        clientSteps.command(
          "a",
          "updateUserAndPostConflict",
          {
            userId: "user-1",
            userName: "Cora",
            postId: "post-1",
            postTitle: "Updated",
          },
          { optimistic: true },
        ),
        clientSteps.submit("a"),
        clientSteps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "baseUser",
        ),
        clientSteps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("posts", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "post-1")),
            ),
          "basePost",
        ),
        clientSteps.read(
          "a",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "overlayUser",
        ),
        clientSteps.read(
          "a",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.findFirst("posts", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "post-1")),
            );
          },
          "overlayPost",
        ),
        clientSteps.assert((ctx) => {
          expect(ctx.lastSubmit["a"]?.status).toBe("conflict");
          expect(ctx.vars.baseUser?.name).toBe("Bea");
          expect(ctx.vars.basePost?.title).toBe("Hello");
          expect(ctx.vars.overlayUser?.name).toBe("Cora");
          expect(ctx.vars.overlayPost?.title).toBe("Updated");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("keeps outbox ordering across clients", async () => {
    const scenario = defineScenario({
      name: "outbox-ordering",
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
        steps.sync("b"),
        steps.read(
          "b",
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "userB",
        ),
        steps.command(
          "b",
          "updateUser",
          (ctx) => {
            const userB = ctx.vars.userB;
            if (!userB) {
              throw new Error("Missing userB");
            }
            return {
              id: "user-1",
              name: "Bea",
              expectedVersion: userB.id.version,
            };
          },
          { optimistic: true, submit: true },
        ),
        steps.sync("a"),
        steps.read(
          "a",
          (_ctx, client) =>
            client.query.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "userFinal",
        ),
        steps.assert((ctx) => {
          const status = ctx.lastSubmit["b"]?.status;
          if (status === "applied") {
            expect(ctx.vars.userFinal?.name).toBe("Bea");
          } else {
            expect(ctx.vars.userFinal?.name).toBe("Ada");
          }
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("does not duplicate applied changes on retry submit", async () => {
    const scenario = defineScenario({
      name: "submit-retry",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a", adapter: { type: "stacked" } },
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
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "userA",
        ),
        steps.submit("a"),
        steps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "retryUser",
        ),
        steps.assert((ctx) => {
          expect(ctx.vars.retryUser?.name).toBe("Ada");
          expect(ctx.vars.retryUser?.id.version).toBe(ctx.vars.userA?.id.version);
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("persists indexeddb base across stacked adapter restarts", async () => {
    const indexedDbGlobals = createIndexedDbGlobals();
    const baseDbName = `lofi-persist-${Math.random().toString(16).slice(2)}`;

    const scenario = defineScenario({
      name: "stacked-indexeddb-persist",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: {
          endpointName: "client-a",
          adapter: { type: "stacked", base: "indexeddb", baseDbName },
        },
      },
      steps: [
        steps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
      ],
    });

    const firstContext = await runScenario(scenario, { indexedDbGlobals });
    await firstContext.cleanup();

    const scenarioAfterRestart = defineScenario({
      name: "stacked-indexeddb-persist-restart",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: {
          endpointName: "client-a",
          adapter: { type: "stacked", base: "indexeddb", baseDbName },
        },
      },
      steps: [
        steps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "persistedUser",
        ),
        steps.read(
          "a",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            );
          },
          "overlayUser",
        ),
        steps.assert((ctx) => {
          expect(ctx.vars.persistedUser?.name).toBe("Ada");
          expect(ctx.vars.overlayUser).toBeNull();
        }),
      ],
    });

    const secondContext = await runScenario(scenarioAfterRestart, { indexedDbGlobals });
    await secondContext.cleanup();
  });

  it("handles large optimistic backlogs", async () => {
    const createSteps = Array.from({ length: 20 }, (_value, index) =>
      steps.command(
        "a",
        "createUser",
        { id: `user-${index + 1}`, name: `User-${index + 1}` },
        { optimistic: true },
      ),
    );

    const scenario = defineScenario({
      name: "optimistic-backlog",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a", adapter: { type: "in-memory" } },
      },
      steps: [
        ...createSteps,
        steps.read(
          "a",
          (_ctx, client) => client.query.find("users", (b) => b.whereIndex("primary")),
          "users",
        ),
        steps.assert((ctx) => {
          expect(ctx.vars.users).toHaveLength(20);
        }),
        steps.submit("a"),
        steps.read(
          "a",
          (_ctx, client) => client.query.find("users", (b) => b.whereIndex("primary")),
          "users",
        ),
        steps.assert((ctx) => {
          expect(ctx.vars.users).toHaveLength(20);
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("keeps non-optimistic commands out of the overlay", async () => {
    const scenario = defineScenario({
      name: "non-optimistic-overlay",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a", adapter: { type: "stacked" } },
      },
      steps: [
        steps.command(
          "a",
          "createUser",
          { id: "user-1", name: "Ada" },
          { optimistic: true, submit: true },
        ),
        steps.command("a", "createUser", { id: "user-2", name: "Bea" }, { optimistic: false }),
        steps.read(
          "a",
          (_ctx, client) => {
            if (!client.overlayQuery) {
              throw new Error("Missing overlay query");
            }
            return client.overlayQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-2")),
            );
          },
          "nonOptimisticUser",
        ),
        steps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-2")),
            ),
          "baseUser",
        ),
        steps.assert((ctx) => {
          expect(ctx.vars.nonOptimisticUser).toBeNull();
          expect(ctx.vars.baseUser).toBeNull();
        }),
        steps.submit("a"),
        steps.read(
          "a",
          (_ctx, client) =>
            client.baseQuery.findFirst("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-2")),
            ),
          "userFinal",
        ),
        steps.assert((ctx) => {
          expect(ctx.vars.userFinal?.name).toBe("Bea");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });
});
