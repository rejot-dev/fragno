import { describe, expect, it, assert } from "vitest";

import {
  column,
  FragnoId,
  FragnoReference,
  idColumn,
  referenceColumn,
  schema,
  type AnySchema,
} from "@fragno-dev/db/schema";
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
import superjson from "superjson";

import { ConcurrencyConflictError, defineSyncCommands } from "@fragno-dev/db";

import { StackedLofiAdapter } from "../adapters/stacked/adapter";
import { defineLocalProjection } from "../local/projection";
import type { LofiQueryState } from "../reactive";
import type {
  AnyLofiLocalProjection,
  LofiMutation,
  LofiSubmitCommandDefinition,
  LofiSyncCommandTxFactory,
} from "../types";
import { createScenarioSteps, defineScenario, runScenario } from "./scenario";
import type { ScenarioClient, ScenarioDefinition } from "./scenario";

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
        .addColumn("authorId", referenceColumn({ table: "users" }))
        .addColumn("title", column("string"))
        .createIndex("idx_author", ["authorId"]),
    ),
);

const userViewSchema = schema("local_user_view", (s) =>
  s.addTable("user_cards", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("displayName", column("string"))
      .createIndex("idx_display", ["displayName"]),
  ),
);

const userAuditSchema = schema("local_user_audit", (s) =>
  s.addTable("user_audit", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("displayName", column("string"))
      .addColumn("touchedAt", column("timestamp"))
      .addColumn("reviewAt", column("timestamp")),
  ),
);

const userMutationCountSchema = schema("local_user_mutation_counts", (s) =>
  s.addTable("user_mutation_counts", (t) =>
    t.addColumn("id", idColumn()).addColumn("count", column("integer")),
  ),
);

const userViewProjection = defineLocalProjection({
  name: "user-view",
  retrieve: ({ match, read }) =>
    read
      .each(match.all(appSchema, "users", ["create", "update"]))
      .map((mutation) => {
        const name = mutation.op === "create" ? mutation.values.name : mutation.set.name;
        return typeof name === "string" ? { mutation, name } : undefined;
      })
      .get(userViewSchema, "user_cards", ({ mutation }) => mutation.externalId),
  mutate: ({ match, retrieved, tx }) => {
    const userCards = tx.forSchema(userViewSchema);
    for (const mutation of match.all(appSchema, "users", "delete")) {
      userCards.delete("user_cards", mutation.externalId);
    }
    for (const {
      item: { mutation, name },
      row: existing,
    } of retrieved) {
      const values = { displayName: name.toUpperCase() };
      if (existing) {
        userCards.update("user_cards", mutation.externalId, (b) => b.set(values));
      } else {
        userCards.create("user_cards", { id: mutation.externalId, ...values });
      }
    }
  },
});

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
  beforeMountState?: LofiQueryState<string[]>;
  duringBootstrapState?: LofiQueryState<string[]>;
  finalStoreState?: LofiQueryState<string[]>;
  baseUsers?: UserRow[];
  overlayUsers?: UserRow[];
  usersB?: UserRow[];
  posts?: PostWithAuthor[];
  postsBeforeSubmit?: PostWithAuthor[];
  postsAfterSubmit?: PostWithAuthor[];
  stackedUser?: UserRow | null;
  baseUser?: UserRow | null;
  overlayUser?: UserRow | null;
  basePost?: PostRow | null;
  overlayPost?: PostRow | null;
  basePostBefore?: PostRow | null;
  basePostAfter?: PostRow | null;
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

const createDeferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const createUserMutation = (options: {
  versionstamp: string;
  id: string;
  name: string;
}): LofiMutation => ({
  op: "create",
  schema: appSchema.name,
  table: "users",
  externalId: options.id,
  values: { name: options.name },
  versionstamp: options.versionstamp,
});

const createUserOutboxEntry = (options: { versionstamp: string; id: string; name: string }) => ({
  versionstamp: options.versionstamp,
  uowId: `uow-${options.versionstamp}`,
  payload: superjson.serialize({
    version: 1,
    mutations: [createUserMutation(options)],
  }),
});

const runScenarioWithIndexedDb = async <
  TSchema extends typeof appSchema,
  TContext = unknown,
  TCommands extends ReadonlyArray<LofiSubmitCommandDefinition> =
    ReadonlyArray<LofiSubmitCommandDefinition>,
  TVars extends ScenarioVars = ScenarioVars,
>(
  scenario: ScenarioDefinition<TSchema, TContext, TCommands, TVars>,
) => {
  const withContext = scenario.createClientContext
    ? scenario
    : ({
        ...scenario,
        createClientContext: () => ({}) as TContext,
      } as ScenarioDefinition<TSchema, TContext, TCommands, TVars>);
  return runScenario(withContext, { indexedDbGlobals: createIndexedDbGlobals() });
};

type ProjectionAdapterKind = "in-memory" | "indexeddb";

const projectionAdapterConfig = (kind: ProjectionAdapterKind) =>
  kind === "in-memory" ? ({ type: "in-memory" } as const) : ({ type: "indexeddb" } as const);

const startProjectionScenario = async (options: {
  name: string;
  adapter: ProjectionAdapterKind;
  localSchemas?: AnySchema[];
  localProjections: AnyLofiLocalProjection[];
}) =>
  await runScenarioWithIndexedDb(
    defineScenario({
      name: options.name,
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      localSchemas: options.localSchemas ?? [userViewSchema],
      localProjections: options.localProjections,
      clients: {
        a: { endpointName: "client-a", adapter: projectionAdapterConfig(options.adapter) },
      },
      steps: [],
    }),
  );

const findUsers = async (client: ScenarioClient<typeof appSchema>) =>
  await client.createQueryEngine(appSchema).find("users", (b) => b.whereIndex("primary"));

const findUserCards = async (client: ScenarioClient<typeof appSchema>) =>
  await client.createQueryEngine(userViewSchema).find("user_cards", (b) => b.whereIndex("primary"));

const expectProjectionStoresEmpty = async (client: ScenarioClient<typeof appSchema>) => {
  expect(await findUsers(client)).toEqual([]);
  expect(await findUserCards(client)).toEqual([]);
};

const requireScenarioClient = (
  client: ScenarioClient<typeof appSchema> | undefined,
): ScenarioClient<typeof appSchema> => {
  assert(client);
  return client;
};

const applyClientMutations = async (
  client: ScenarioClient<typeof appSchema>,
  mutations: LofiMutation[],
) => {
  assert(client.adapter.applyMutations);
  await client.adapter.applyMutations(mutations);
};

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
          b
            .whereIndex("primary", (eb) => eb("id", "=", payload.postId))
            .joinOne("author", "users", (author) =>
              author.onIndex("primary", (eb) => eb("id", "=", eb.parent("authorId"))),
            ),
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
          b
            .whereIndex("primary", (eb) => eb("id", "=", payload.postId))
            .joinOne("author", "users", (author) =>
              author.onIndex("primary", (eb) => eb("id", "=", eb.parent("authorId"))),
            ),
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

const optimisticSecureRetitlePostHandler = retitlePostHandler;

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
  defineCommand({
    name: "secureRetitlePostOptimistic",
    handler: secureRetitlePostHandler,
  }),
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
    name: "secureRetitlePostOptimistic",
    target: { fragment: "lofi-test", schema: appSchema.name },
    handler: optimisticSecureRetitlePostHandler,
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
  it("constructs reactive query stores and records emissions", async () => {
    const scenario = defineScenario({
      name: "reactive-store-sync",
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
        steps.createStore("a", "users", "users", (b) => b.whereIndex("primary"), {
          initialData: [],
        }),
        steps.command("a", "createUser", { id: "user-1", name: "Ada" }, { submit: true }),
        steps.sync("a"),
        steps.waitForStore("a", "users", (state) =>
          Array.isArray(state.data)
            ? state.data.some((row) => (row as { name?: unknown }).name === "Ada")
            : false,
        ),
        steps.readStore("a", "users", "users"),
        steps.assertStoreEmissions("a", "users", (values) => {
          assert(values.some((value) => value.loading));
          expect(values.at(-1)?.data).toEqual([expect.objectContaining({ name: "Ada" })]);
        }),
        steps.assert((ctx) => {
          expect(ctx.vars.users).toEqual([expect.objectContaining({ name: "Ada" })]);
        }),
      ],
    });

    const ctx = await runScenarioWithIndexedDb(scenario);
    await ctx.cleanup();
  });

  it("bootstraps a scenario client and persists the bootstrap marker", async () => {
    const scenario = defineScenario({
      name: "bootstrap-client",
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
        steps.command("a", "createUser", { id: "user-1", name: "Ada" }, { submit: true }),
        steps.bootstrap("a", "default"),
        steps.read(
          "a",
          (_ctx, client) =>
            client.query.find("users", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "user-1")),
            ),
          "users",
        ),
        steps.assert(async (ctx) => {
          assert(ctx.lastBootstrap["a"]?.sources["default"]?.appliedEntries === 1);
          expect(ctx.vars.users).toEqual([expect.objectContaining({ name: "Ada" })]);
          assert(
            (await ctx.clients["a"]?.adapter.getMeta("client-a:default:outbox::bootstrap")) ===
              "complete",
          );
        }),
      ],
    });

    const ctx = await runScenarioWithIndexedDb(scenario);
    await ctx.cleanup();
  });

  it("models SSR store data staying visible until bootstrap finishes", async () => {
    const bootstrapResponse = createDeferred<Response>();
    let outboxFetchCount = 0;
    const scenario = defineScenario({
      name: "ssr-bootstrap-store",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: {
          endpointName: "client-a",
          adapter: { type: "in-memory" },
          fetch: ({ baseFetch }) =>
            (async (input, init) => {
              const url = new URL(typeof input === "string" ? input : input.toString());
              if (url.pathname.endsWith("/_internal/outbox")) {
                outboxFetchCount += 1;
                return bootstrapResponse.promise;
              }
              return baseFetch(input, init);
            }) as typeof fetch,
        },
      },
      steps: [
        steps.createStore("a", "users", "users", (b) => b.whereIndex("primary"), {
          initialData: () => ["SSR Alice"],
          map: (rows) => (rows as UserRow[]).map((row) => row.name),
          mount: false,
        }),
        steps.readStoreState("a", "users", "beforeMountState"),
        steps.assert((ctx) => {
          expect(ctx.vars.beforeMountState).toMatchObject({
            data: ["SSR Alice"],
            loading: false,
            synced: false,
            error: null,
          });
          assert(outboxFetchCount === 0);
        }),
        steps.mountStore("a", "users"),
        steps.waitForStore(
          "a",
          "users",
          (state) =>
            state.loading &&
            Array.isArray(state.data) &&
            state.data[0] === "SSR Alice" &&
            outboxFetchCount === 1,
        ),
        steps.readStoreState("a", "users", "duringBootstrapState"),
        steps.assert((ctx) => {
          expect(ctx.vars.duringBootstrapState).toMatchObject({
            data: ["SSR Alice"],
            loading: true,
            synced: false,
            error: null,
          });
          assert(outboxFetchCount === 1);
          bootstrapResponse.resolve(
            new Response(
              JSON.stringify([
                createUserOutboxEntry({ versionstamp: "001", id: "user-1", name: "Synced" }),
              ]),
            ),
          );
        }),
        steps.waitForBootstrap("a"),
        steps.waitForStore("a", "users", (state) => state.synced),
        steps.readStoreState("a", "users", "finalStoreState"),
        steps.assert((ctx) => {
          expect(ctx.vars.finalStoreState).toMatchObject({
            data: ["Synced"],
            loading: false,
            synced: true,
            error: null,
          });
        }),
      ],
    });

    const ctx = await runScenarioWithIndexedDb(scenario);
    await ctx.cleanup();
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
          assert(response?.status === "conflict");
          if (response && response.status === "conflict") {
            assert(response.reason === "write_congestion");
          }
          const user = ctx.vars.userAFinal;
          assert(user?.name === "Aria");
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
          assert(user?.id.version === 2);
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
            client.query.find("posts", (b) =>
              b
                .whereIndex("primary")
                .joinOne("author", "users", (author) =>
                  author.onIndex("primary", (eb) => eb("id", "=", eb.parent("authorId"))),
                ),
            ),
          "posts",
        ),
        steps.assert((ctx) => {
          const posts = ctx.vars.posts;
          expect(posts).toHaveLength(1);
          assert(posts?.[0]?.title === "Updated");
          assert(posts?.[0]?.author?.name === "Ada");
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
          assert(response?.status === "applied");
          const user = ctx.vars.user;
          assert(user?.name === "Ada");
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
            client.query.find("posts", (b) =>
              b
                .whereIndex("primary")
                .joinOne("author", "users", (author) =>
                  author.onIndex("primary", (eb) => eb("id", "=", eb.parent("authorId"))),
                ),
            ),
          "posts",
        ),
        authSteps.assert((ctx) => {
          const posts = ctx.vars.posts;
          expect(posts).toHaveLength(1);
          assert(posts?.[0]?.title === "Hello");
          assert(posts?.[0]?.author?.name === "Ada");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("rolls back optimistic edits when auth rejects on submit", async () => {
    const scenario = defineScenario<typeof appSchema, AuthContext>({
      name: "auth-optimistic-rejected",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      clients: {
        a: { endpointName: "client-a" },
        b: { endpointName: "client-b", adapter: { type: "stacked" } },
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
          "secureRetitlePostOptimistic",
          { postId: "post-1", expectedAuthorName: "Ada", title: "Denied" },
          { optimistic: true },
        ),
        authSteps.read(
          "b",
          (_ctx, client) =>
            client.query.find("posts", (b) =>
              b
                .whereIndex("primary")
                .joinOne("author", "users", (author) =>
                  author.onIndex("primary", (eb) => eb("id", "=", eb.parent("authorId"))),
                ),
            ),
          "postsBeforeSubmit",
        ),
        authSteps.read(
          "b",
          (_ctx, client) =>
            client.baseQuery.findFirst("posts", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "post-1")),
            ),
          "basePostBefore",
        ),
        authSteps.submit("b"),
        authSteps.read(
          "b",
          (_ctx, client) =>
            client.query.find("posts", (b) =>
              b
                .whereIndex("primary")
                .joinOne("author", "users", (author) =>
                  author.onIndex("primary", (eb) => eb("id", "=", eb.parent("authorId"))),
                ),
            ),
          "postsAfterSubmit",
        ),
        authSteps.read(
          "b",
          (_ctx, client) =>
            client.baseQuery.findFirst("posts", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", "post-1")),
            ),
          "basePostAfter",
        ),
        authSteps.assert((ctx) => {
          const before = ctx.vars.postsBeforeSubmit;
          const after = ctx.vars.postsAfterSubmit;
          expect(before).toHaveLength(1);
          assert(before?.[0]?.title === "Denied");
          assert(before?.[0]?.author?.name === "Ada");
          assert(ctx.vars.basePostBefore?.title === "Hello");
          assert(ctx.lastSubmit["b"]?.status === "applied");
          expect(after).toHaveLength(1);
          assert(after?.[0]?.title === "Hello");
          assert(after?.[0]?.author?.name === "Ada");
          assert(ctx.vars.basePostAfter?.title === "Hello");
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
          assert(stackedUser?.name === "Ada");
          expect(baseUser).toBeNull();
          assert(overlayUser?.name === "Ada");
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
          assert(baseUser?.name === "Ada");
          expect(overlayUser).toBeNull();
          assert(stackedUser?.name === "Ada");
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
          assert(ctx.vars.stackedUser?.name === "Ada");
          expect(ctx.vars.overlayUser).toBeNull();
          assert(ctx.vars.baseUser?.name === "Ada");
          assert(ctx.vars.userB?.name === "Ada");
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
          assert(baseUser?.name === "Ada");
          assert(overlayUser?.name === "Bea");
          assert(stackedUser?.name === "Bea");

          const client = ctx.clients["a"];
          const baseStore = client.stores.base;
          const overlayStore = client.stores.overlay;
          expect(baseStore).toBeDefined();
          expect(overlayStore).toBeDefined();
          const baseRow = baseStore?.getRow(appSchema.name, "users", "user-1");
          const overlayRow = overlayStore?.getRow(appSchema.name, "users", "user-1");
          assert(baseRow?.data["name"] === "Ada");
          assert(overlayRow?.data["name"] === "Bea");
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
          assert(ctx.lastSubmit["a"]?.status === "applied");
          assert(ctx.lastSubmit["b"]?.status === "conflict");
          assert(ctx.vars.userAFinal?.name === "Aria");
          assert(ctx.vars.baseUser?.name === "Aria");
          assert(ctx.vars.overlayUser?.name === "Bea");
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
          assert(ctx.lastSubmit["a"]?.status === "conflict");
          assert(ctx.vars.baseUser?.name === "Bea");
          assert(ctx.vars.overlayUser?.name === "Dana");
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
          assert(ctx.lastSubmit["a"]?.status === "conflict");
          assert(ctx.vars.baseUser?.name === "Bea");
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
          assert(ctx.lastSubmit["a"]?.status === "conflict");
          assert(ctx.vars.baseUser?.name === "Bea");
          assert(ctx.vars.basePost?.title === "Hello");
          assert(ctx.vars.overlayUser?.name === "Cora");
          assert(ctx.vars.overlayPost?.title === "Updated");
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
            assert(ctx.vars.userFinal?.name === "Bea");
          } else {
            assert(ctx.vars.userFinal?.name === "Ada");
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
          assert(ctx.vars.retryUser?.name === "Ada");
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
          assert(ctx.vars.persistedUser?.name === "Ada");
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
          assert(ctx.vars.userFinal?.name === "Bea");
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("materializes local schemas from synced outbox mutations", async () => {
    const scenario = defineScenario({
      name: "local-schema-materialized-view",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      localSchemas: [userViewSchema],
      localProjections: [userViewProjection],
      clients: {
        a: { endpointName: "client-a", adapter: { type: "in-memory" } },
      },
      steps: [
        steps.command("a", "createUser", { id: "user-1", name: "Ada" }, { submit: true }),
        steps.sync("a"),
        steps.assert(async (ctx) => {
          const query = ctx.clients["a"]?.createQueryEngine(userViewSchema);
          expect(await query?.find("user_cards", (b) => b.whereIndex("primary"))).toMatchObject([
            { displayName: "ADA" },
          ]);
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  for (const adapter of ["in-memory", "indexeddb"] as const) {
    it(`skips projection mutate when retrieve returns undefined (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-retrieve-undefined-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            retrieve: () => undefined,
            mutate: () => {
              throw new Error("mutate should not run");
            },
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await applyClientMutations(client, [
          createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" }),
        ]);
        expect(await findUsers(client)).toMatchObject([{ name: "Ada" }]);
        expect(await findUserCards(client)).toEqual([]);
      } finally {
        await context.cleanup();
      }
    });

    it(`filters read.each mapper misses before local reads (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-read-each-map-filter-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            retrieve: ({ match, read }) =>
              read
                .each(match.all(appSchema, "users", "create"))
                .map((mutation) => {
                  if (mutation.externalId === "skip-undefined") {
                    return undefined;
                  }
                  if (mutation.externalId === "skip-null") {
                    return null;
                  }
                  if (mutation.externalId === "skip-false") {
                    return false;
                  }
                  return { mutation, displayName: mutation.values.name.toUpperCase() };
                })
                .get(userViewSchema, "user_cards", ({ mutation }) => mutation.externalId),
            mutate: ({ retrieved, tx }) => {
              const userCards = tx.forSchema(userViewSchema);
              for (const { item, row } of retrieved) {
                if (row) {
                  userCards.update("user_cards", item.mutation.externalId, (b) =>
                    b.set({ displayName: item.displayName }),
                  );
                } else {
                  userCards.create("user_cards", {
                    id: item.mutation.externalId,
                    displayName: item.displayName,
                  });
                }
              }
            },
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await applyClientMutations(client, [
          createUserMutation({ versionstamp: "v1", id: "skip-undefined", name: "Ada" }),
          createUserMutation({ versionstamp: "v1", id: "skip-null", name: "Bea" }),
          createUserMutation({ versionstamp: "v1", id: "skip-false", name: "Cia" }),
          createUserMutation({ versionstamp: "v1", id: "keep", name: "Dia" }),
        ]);
        expect(await findUserCards(client)).toMatchObject([{ displayName: "DIA" }]);
      } finally {
        await context.cleanup();
      }
    });

    it(`rolls back source mutations when projection retrieve throws (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-retrieve-throws-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            retrieve: () => {
              throw new Error("retrieve exploded");
            },
            mutate: () => undefined,
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await expect(
          applyClientMutations(client, [
            createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" }),
          ]),
        ).rejects.toThrow("retrieve exploded");
        await expectProjectionStoresEmpty(client);
      } finally {
        await context.cleanup();
      }
    });

    it(`rolls back source mutations when projection mutate throws (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-mutate-throws-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            mutate: () => {
              throw new Error("mutate exploded");
            },
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await expect(
          applyClientMutations(client, [
            createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" }),
          ]),
        ).rejects.toThrow("mutate exploded");
        await expectProjectionStoresEmpty(client);
      } finally {
        await context.cleanup();
      }
    });

    it(`does not commit projection writes queued before mutate throws (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-mutate-throws-after-write-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            mutate: ({ tx }) => {
              tx.forSchema(userViewSchema).create("user_cards", {
                id: "user-1",
                displayName: "ADA",
              });
              throw new Error("mutate exploded after write");
            },
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await expect(
          applyClientMutations(client, [
            createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" }),
          ]),
        ).rejects.toThrow("mutate exploded after write");
        await expectProjectionStoresEmpty(client);
      } finally {
        await context.cleanup();
      }
    });

    it(`rolls back earlier projection writes when a later projection throws (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-later-projection-throws-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            mutate: ({ tx }) => {
              tx.forSchema(userViewSchema).create("user_cards", {
                id: "user-1",
                displayName: "ADA",
              });
            },
          }),
          defineLocalProjection({
            mutate: () => {
              throw new Error("second projection exploded");
            },
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await expect(
          applyClientMutations(client, [
            createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" }),
          ]),
        ).rejects.toThrow("second projection exploded");
        await expectProjectionStoresEmpty(client);
      } finally {
        await context.cleanup();
      }
    });

    it(`rejects async projection retrieve and keeps stores unchanged (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-async-retrieve-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            retrieve: (() => Promise.resolve(undefined)) as never,
            mutate: () => undefined,
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await expect(
          applyClientMutations(client, [
            createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" }),
          ]),
        ).rejects.toThrow("Projection retrieve must be synchronous");
        await expectProjectionStoresEmpty(client);
      } finally {
        await context.cleanup();
      }
    });

    it(`rejects async projection mutate and keeps stores unchanged (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-async-mutate-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            mutate: (() => Promise.resolve(undefined)) as never,
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await expect(
          applyClientMutations(client, [
            createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" }),
          ]),
        ).rejects.toThrow("Projection mutate must be synchronous");
        await expectProjectionStoresEmpty(client);
      } finally {
        await context.cleanup();
      }
    });

    it(`rejects promises nested inside projection retrieve plans (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-nested-promise-read-plan-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            retrieve: () => ({ nested: Promise.resolve(undefined) }) as never,
            mutate: () => undefined,
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await expect(
          applyClientMutations(client, [
            createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" }),
          ]),
        ).rejects.toThrow("Projection retrieve must return read descriptors, not promises");
        await expectProjectionStoresEmpty(client);
      } finally {
        await context.cleanup();
      }
    });

    it(`rejects projection reads from source schemas (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-source-read-rejected-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            retrieve: ({ read }) => read.get(appSchema, "users", "user-1"),
            mutate: () => undefined,
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await expect(
          applyClientMutations(client, [
            createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" }),
          ]),
        ).rejects.toThrow("Projection reads must target a local schema: app");
        await expectProjectionStoresEmpty(client);
      } finally {
        await context.cleanup();
      }
    });

    it(`rejects projection writes to source schemas (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-source-write-rejected-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            mutate: ({ tx }) => {
              tx.forSchema(appSchema).create("users", { id: "user-1", name: "Ada" });
            },
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await expect(
          applyClientMutations(client, [
            createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" }),
          ]),
        ).rejects.toThrow("Projection writes must target a local schema: app");
        await expectProjectionStoresEmpty(client);
      } finally {
        await context.cleanup();
      }
    });

    it(`does not mark a failed outbox entry as applied (${adapter})`, async () => {
      let shouldThrow = true;
      const context = await startProjectionScenario({
        name: `local-schema-failed-outbox-retry-${adapter}`,
        adapter,
        localProjections: [
          defineLocalProjection({
            mutate: ({ match, tx }) => {
              if (shouldThrow) {
                throw new Error("retryable projection failure");
              }
              const userCards = tx.forSchema(userViewSchema);
              for (const mutation of match.all(appSchema, "users", "create")) {
                userCards.create("user_cards", {
                  id: mutation.externalId,
                  displayName: mutation.values.name.toUpperCase(),
                });
              }
            },
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        const entry = {
          sourceKey: "source",
          uowId: "uow-v1",
          versionstamp: "v1",
          mutations: [createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" })],
        };

        await expect(client.adapter.applyOutboxEntry(entry)).rejects.toThrow(
          "retryable projection failure",
        );
        await expectProjectionStoresEmpty(client);

        shouldThrow = false;
        await expect(client.adapter.applyOutboxEntry(entry)).resolves.toEqual({
          applied: true,
        });
        expect(await findUsers(client)).toMatchObject([{ name: "Ada" }]);
        expect(await findUserCards(client)).toMatchObject([{ displayName: "ADA" }]);
        await expect(client.adapter.applyOutboxEntry(entry)).resolves.toEqual({
          applied: false,
        });
      } finally {
        await context.cleanup();
      }
    });
  }

  for (const adapter of ["in-memory", "indexeddb"] as const) {
    it(`allows later projections to read local rows written by earlier projections (${adapter})`, async () => {
      const context = await startProjectionScenario({
        name: `local-schema-staged-projection-reads-${adapter}`,
        adapter,
        localSchemas: [userViewSchema, userAuditSchema],
        localProjections: [
          defineLocalProjection({
            mutate: ({ match, tx }) => {
              const userCards = tx.forSchema(userViewSchema);
              for (const mutation of match.all(appSchema, "users", "create")) {
                userCards.create("user_cards", {
                  id: mutation.externalId,
                  displayName: mutation.values.name.toUpperCase(),
                });
              }
            },
          }),
          defineLocalProjection({
            retrieve: ({ match, read }) =>
              read
                .each(match.all(appSchema, "users", "create"))
                .get(userViewSchema, "user_cards", (mutation) => mutation.externalId),
            mutate: ({ retrieved, tx }) => {
              const userAudit = tx.forSchema(userAuditSchema);
              for (const { item: mutation, row: card } of retrieved) {
                if (!card) {
                  throw new Error("staged card was not visible");
                }
                userAudit.create("user_audit", {
                  id: mutation.externalId,
                  displayName: card.displayName,
                  touchedAt: new Date(0),
                  reviewAt: new Date(0),
                });
              }
            },
          }),
        ],
      });

      const client = requireScenarioClient(context.clients["a"]);

      try {
        await applyClientMutations(client, [
          createUserMutation({ versionstamp: "v1", id: "user-1", name: "Ada" }),
        ]);
        const auditRows = await client
          .createQueryEngine(userAuditSchema)
          .find("user_audit", (b) => b.whereIndex("primary"));
        expect(auditRows).toMatchObject([{ displayName: "ADA" }]);
      } finally {
        await context.cleanup();
      }
    });
  }

  it("can implement a local counter using only local projection reads", async () => {
    const scenario = defineScenario({
      name: "local-schema-projection-counter",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      localSchemas: [userMutationCountSchema],
      localProjections: [
        defineLocalProjection({
          name: "user-mutation-counter",
          retrieve: ({ match, read }) =>
            read
              .each(match.all(appSchema, "users", ["create", "update"]))
              .get(
                userMutationCountSchema,
                "user_mutation_counts",
                (mutation) => mutation.externalId,
              ),
          mutate: ({ retrieved, tx }) => {
            const countsById = new Map<string, number>();
            const existingById = new Map<string, (typeof retrieved)[number]["row"]>();
            for (const { item: mutation, row: existing } of retrieved) {
              const currentCount = countsById.get(mutation.externalId) ?? existing?.count ?? 0;
              countsById.set(mutation.externalId, currentCount + 1);
              if (existing) {
                existingById.set(mutation.externalId, existing);
              }
            }

            const userCounts = tx.forSchema(userMutationCountSchema);
            for (const [externalId, count] of countsById) {
              if (existingById.has(externalId)) {
                userCounts.update("user_mutation_counts", externalId, (b) => b.set({ count }));
              } else {
                userCounts.create("user_mutation_counts", { id: externalId, count });
              }
            }
          },
        }),
      ],
      clients: {
        a: { endpointName: "client-a", adapter: { type: "in-memory" } },
      },
      steps: [
        steps.command("a", "createUser", { id: "user-1", name: "Ada" }, { optimistic: false }),
        steps.command("a", "renameUser", { id: "user-1", name: "Bea" }, { optimistic: false }),
        steps.command("a", "renameUser", { id: "user-1", name: "Cia" }, { optimistic: false }),
        steps.command("a", "renameUser", { id: "user-1", name: "Dia" }, { optimistic: false }),
        steps.command("a", "renameUser", { id: "user-1", name: "Eve" }, { optimistic: false }),
        steps.submit("a"),
        steps.assert(async (ctx) => {
          const query = ctx.clients["a"]?.createQueryEngine(userMutationCountSchema);
          expect(
            await query?.find("user_mutation_counts", (b) => b.whereIndex("primary")),
          ).toMatchObject([{ count: 5 }]);
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("supports projection update builder now, interval, and check helpers", async () => {
    const scenario = defineScenario({
      name: "local-schema-projection-update-builder",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      localSchemas: [userAuditSchema],
      localProjections: [
        defineLocalProjection({
          name: "user-audit",
          retrieve: ({ match, read }) =>
            read
              .each(match.all(appSchema, "users", ["create", "update"]))
              .map((mutation) => {
                const name = mutation.op === "create" ? mutation.values.name : mutation.set.name;
                return typeof name === "string" ? { mutation, name } : undefined;
              })
              .get(userAuditSchema, "user_audit", ({ mutation }) => mutation.externalId),
          mutate: ({ retrieved, tx }) => {
            const userAudit = tx.forSchema(userAuditSchema);
            for (const {
              item: { mutation, name },
              row: existing,
            } of retrieved) {
              if (!existing) {
                userAudit.create("user_audit", {
                  id: mutation.externalId,
                  displayName: name,
                  touchedAt: new Date(0),
                  reviewAt: new Date(0),
                });
                continue;
              }

              userAudit.update("user_audit", existing.id, (b) => {
                const now = b.now();
                return b
                  .set({
                    displayName: name,
                    touchedAt: now,
                    reviewAt: now.plus(b.interval({ minutes: 5 })),
                  })
                  .check();
              });
            }
          },
        }),
      ],
      clients: {
        a: { endpointName: "client-a", adapter: { type: "indexeddb" } },
      },
      steps: [
        steps.command("a", "createUser", { id: "user-1", name: "Ada" }, { submit: true }),
        steps.sync("a"),
        steps.command("a", "renameUser", { id: "user-1", name: "Bea" }, { submit: true }),
        steps.sync("a"),
        steps.assert(async (ctx) => {
          const query = ctx.clients["a"]?.createQueryEngine(userAuditSchema);
          const rows = await query?.find("user_audit", (b) => b.whereIndex("primary"));
          expect(rows).toHaveLength(1);

          const row = rows?.[0];
          assert(row?.displayName === "Bea");
          expect(row?.touchedAt).toBeInstanceOf(Date);
          expect(row?.reviewAt).toBeInstanceOf(Date);
          if (row?.touchedAt instanceof Date && row.reviewAt instanceof Date) {
            assert(row.reviewAt.getTime() - row.touchedAt.getTime() === 300_000);
          }
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("fails projection update checks when the local row version is stale", async () => {
    const scenario = defineScenario({
      name: "local-schema-projection-stale-check",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      localSchemas: [userAuditSchema],
      localProjections: [
        defineLocalProjection({
          retrieve: ({ match, read }) =>
            read
              .each(match.all(appSchema, "users", ["create", "update"]))
              .map((mutation) => {
                const name = mutation.op === "create" ? mutation.values.name : mutation.set.name;
                return typeof name === "string" ? { mutation, name } : undefined;
              })
              .get(userAuditSchema, "user_audit", ({ mutation }) => mutation.externalId),
          mutate: ({ retrieved, tx }) => {
            const userAudit = tx.forSchema(userAuditSchema);
            for (const {
              item: { mutation, name },
              row: existing,
            } of retrieved) {
              if (!existing) {
                userAudit.create("user_audit", {
                  id: mutation.externalId,
                  displayName: name,
                  touchedAt: new Date(0),
                  reviewAt: new Date(0),
                });
                continue;
              }

              userAudit.update(
                "user_audit",
                FragnoId.fromExternal(mutation.externalId, existing.id.version + 1),
                (b) => b.set({ displayName: name }).check(),
              );
            }
          },
        }),
      ],
      clients: {
        a: { endpointName: "client-a", adapter: { type: "in-memory" } },
      },
      steps: [
        steps.command("a", "createUser", { id: "user-1", name: "Ada" }, { submit: true }),
        steps.sync("a"),
        steps.command("a", "renameUser", { id: "user-1", name: "Bea" }, { submit: true }),
        steps.sync("a"),
      ],
    });

    await expect(runScenarioWithIndexedDb(scenario)).rejects.toThrow(
      "Projection update check failed",
    );
  });

  it("updates and deletes local schema rows for each client", async () => {
    const scenario = defineScenario({
      name: "local-schema-update-delete",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      localSchemas: [userViewSchema],
      localProjections: [userViewProjection],
      clients: {
        a: { endpointName: "client-a", adapter: { type: "in-memory" } },
        b: { endpointName: "client-b", adapter: { type: "in-memory" } },
      },
      steps: [
        steps.command("a", "createUser", { id: "user-1", name: "Ada" }, { submit: true }),
        steps.sync("a"),
        steps.sync("b"),
        steps.command("a", "renameUser", { id: "user-1", name: "Bea" }, { submit: true }),
        steps.sync("a"),
        steps.sync("b"),
        steps.assert(async (ctx) => {
          for (const name of ["a", "b"] as const) {
            const query = ctx.clients[name]?.createQueryEngine(userViewSchema);
            expect(await query?.find("user_cards", (b) => b.whereIndex("primary"))).toMatchObject([
              { displayName: "BEA" },
            ]);
          }
        }),
        steps.command("a", "deleteUser", { id: "user-1", expectedVersion: 1 }, { submit: true }),
        steps.sync("a"),
        steps.sync("b"),
        steps.assert(async (ctx) => {
          for (const name of ["a", "b"] as const) {
            const query = ctx.clients[name]?.createQueryEngine(userViewSchema);
            expect(await query?.find("user_cards", (b) => b.whereIndex("primary"))).toEqual([]);
          }
        }),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });

  it("exposes local schemas to reactive scenario stores and stacked overlays", async () => {
    const scenario = defineScenario({
      name: "local-schema-reactive-stacked",
      server: {
        fragmentName: "lofi-test",
        schema: appSchema,
        syncCommands,
      },
      clientCommands,
      localSchemas: [userViewSchema],
      localProjections: [userViewProjection],
      clients: {
        a: { endpointName: "client-a", adapter: { type: "stacked", base: "in-memory" } },
      },
      steps: [
        steps.createStore("a", "cards", "user_cards" as never, (b) => b.whereIndex("primary"), {
          schema: userViewSchema,
          initialData: [],
        }),
        steps.command("a", "createUser", { id: "user-1", name: "Ada" }, { optimistic: true }),
        steps.waitForStore(
          "a",
          "cards",
          (state) =>
            Array.isArray(state.data) &&
            state.data.some((row) => (row as { displayName?: string }).displayName === "ADA"),
        ),
        steps.submit("a"),
        steps.sync("a"),
        steps.waitForStore(
          "a",
          "cards",
          (state) =>
            Array.isArray(state.data) &&
            state.data.some((row) => (row as { displayName?: string }).displayName === "ADA"),
        ),
      ],
    });

    const context = await runScenarioWithIndexedDb(scenario);
    await context.cleanup();
  });
});
