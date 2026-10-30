import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { backofficeScopeJurisdiction } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { WorkerTypeChecker } from "@fragno-dev/codemode/compiler/compile-worker";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import { parse, stringify } from "devalue";
import { Kysely } from "kysely";
import { actor, setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import type { SqliteDatabase } from "rivetkit/db";

import { defaultFragnoRuntime } from "@fragno-dev/core";

import {
  piAgentObjectName,
  type PiAgent,
  type PiAgentAddress,
} from "@/fragno/pi/agent/pi-agent-contract";
import { createReson8Server } from "@/fragno/reson8";
import type { CreateSandboxRuntimeProviders } from "@/sandbox/contracts";

import type { AuthDatabase } from "../../../workers/auth-object";
import { noOpBackofficeConfiguredObjectLifecycle } from "../../../workers/lib/backoffice-fragment-durable-object";
import type { BackofficeRuntimeEnv } from "../backoffice-runtime-env";
import { discardBackofficeTelemetry } from "../backoffice-telemetry";
import { objectAddressJurisdiction } from "../cloudflare-durable-object-factory";
import type { BackofficeDatabaseAdapterFactory } from "../database-adapters";
import {
  createAuthorizedBackofficeObjectRequest,
  removeBackofficeInternalContextHeader,
} from "../internal-object-request";
import { noopBackofficeKernelObserver } from "../kernel";
import {
  createLocalBackofficeRuntimeConfig,
  type LocalBackofficeObjects,
  type LocalObjectBindingName,
} from "../local-object-factory";
import { createNodeBackofficeObjectImplementation } from "../node/node-object-implementation";
import {
  assertBackofficeObjectAddressAllowed,
  createBackofficeObjectRegistry,
  encodeBackofficeObjectAddress,
  type BackofficeObjectAddress,
  type BackofficeObjectBinding,
  type BackofficeObjectFactory,
  type BackofficeObjectHandle,
  type BackofficeObjectHttp,
} from "../object-registry";
import {
  createObjectsAuthorityResolver,
  type BackofficeRuntimeServices,
} from "../runtime-services";
import { RIVET_DURABLE_OBJECT_TABLES, RivetDurableObjectState } from "./rivet-durable-object-state";
import {
  executeRivetSqlite,
  nativeRivetSqlite,
  RivetSqliteDialect,
  rivetChordSqlite,
  rivetSqlite,
} from "./rivet-sqlite";

/** Where objects that are not yet on Rivet are copied from. */
export type CloudflareObjectSource = {
  /** The objects Worker's workers.dev URL, which still reaches Cloudflare after DNS cutover. */
  workerUrl: string;
  /** The objects Worker's `WORKER_MIGRATOR_TOKEN`. */
  token: string;
};

export type RivetBackofficeHostOptions = {
  objects: LocalBackofficeObjects;
  runtimeEnv: BackofficeRuntimeEnv;
  workerTypeChecker: WorkerTypeChecker;
  createSandboxProviders: CreateSandboxRuntimeProviders;
  /** The Rivet Engine; a local one starts when it is local and not running. */
  rivetEndpoint: string;
  /** Null starts every object empty, as when nothing ran on Cloudflare. */
  cloudflare: CloudflareObjectSource | null;
};

export type RivetBackofficeHost = {
  env: BackofficeRuntimeEnv;
  services: BackofficeRuntimeServices;
  stop(): Promise<void>;
};

/** An actor hosts the object `name` of `binding`, as a Durable Object did on Cloudflare. */
type RivetObjectKey = {
  binding: LocalObjectBindingName;
  name: string;
  /** The jurisdiction the object was kept in on Cloudflare; empty when none. */
  jurisdiction: string;
};

/** What an actor keeps while awake: its object, and the object's Durable Object state. */
type RivetObjectVars = { state: RivetDurableObjectState; object: unknown };

/** Commands cross Rivet as devalue, which keeps the Dates, Maps and bytes Durable Object RPC kept. */
type EncodedCommandOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string; stack: string | null } };

/**
 * Runs every Backoffice object as a Rivet actor in this process and returns the runtime that
 * reaches them. Each actor copies its object from Cloudflare the first time it starts.
 */
export async function startRivetBackofficeHost(
  options: RivetBackofficeHostOptions,
): Promise<RivetBackofficeHost> {
  let started: { services: BackofficeRuntimeServices; factory: RivetObjectFactory } | null = null;
  const registry = setup({
    use: {
      backofficeObject: createBackofficeObjectActor(options, () => {
        if (!started) {
          throw new Error("The Rivet Backoffice host started an object before its runtime.");
        }
        return started;
      }),
    },
    endpoint: options.rivetEndpoint,
    // The Node server stops the registry once it has closed its own listeners.
    shutdown: { disableSignalHandlers: true },
  });
  const client = createClient<typeof registry>(options.rivetEndpoint);
  const factory = new RivetObjectFactory(
    // Naming the actor's vars cost rivetkit its inferred action types.
    (key) =>
      client.backofficeObject.getOrCreate([
        key.binding,
        key.name,
        key.jurisdiction,
      ]) as unknown as RivetObjectHandle,
    options.runtimeEnv,
  );
  const objects = createBackofficeObjectRegistry(factory);
  const services: BackofficeRuntimeServices = {
    objects,
    // Only objects open databases, each on its own actor's SQLite.
    adapters: unavailableDatabaseAdapters,
    config: createLocalBackofficeRuntimeConfig(options.runtimeEnv, options.objects, false),
    authorityResolver: createObjectsAuthorityResolver(objects, Date.now),
    kernelObserver: noopBackofficeKernelObserver,
    codemodeExecutor: options.runtimeEnv.codemode,
    workerTypeChecker: options.workerTypeChecker,
    reson8: options.runtimeEnv.RESON8_API_KEY
      ? createReson8Server(options.runtimeEnv.RESON8_API_KEY)
      : null,
    // Node's fetch connects to private addresses, so the Rivet host does not download.
    webFetch: null,
    fragnoRuntime: defaultFragnoRuntime,
  };
  started = { services, factory };
  await registry.startAndWait();
  return {
    env: options.runtimeEnv,
    services,
    stop: async () => {
      await registry.shutdown();
    },
  };
}

const unavailableDatabaseAdapters: BackofficeDatabaseAdapterFactory = {
  createAdapter() {
    throw new Error("Backoffice databases open only inside Rivet object actors.");
  },
  forScope() {
    return unavailableDatabaseAdapters;
  },
};

function createBackofficeObjectActor(
  options: RivetBackofficeHostOptions,
  getHost: () => { services: BackofficeRuntimeServices; factory: RivetObjectFactory },
) {
  // rivetkit cannot infer vars from `createVars` alongside the other hooks.
  return actor<
    undefined,
    undefined,
    undefined,
    RivetObjectVars,
    undefined,
    typeof nativeRivetSqlite
  >({
    db: nativeRivetSqlite,
    options: {
      // Copying a large object from Cloudflare takes one round trip per 4 MB.
      onMigrateTimeout: 15 * 60_000,
      createVarsTimeout: 60_000,
      // Commands such as Pi turns and sandbox starts run as long as they did on Cloudflare.
      actionTimeout: 15 * 60_000,
    },
    onMigrate: async (c) => {
      await importCloudflareObject(
        rivetSqlite(c.db),
        parseRivetObjectKey(c.key),
        options.cloudflare,
      );
    },
    createVars: async (c) => {
      const key = parseRivetObjectKey(c.key);
      const database = rivetSqlite(c.db);
      const state = await RivetDurableObjectState.open({
        database,
        name: key.name,
        actorId: c.actorId,
        scheduleAlarm: async (timestamp) => {
          for (const event of await c.schedule.list()) {
            if (event.action === "alarm") {
              await c.schedule.cancel(event.id);
            }
          }
          if (timestamp !== null) {
            await c.schedule.at(timestamp, "alarm");
          }
        },
        keepAwake: (promise) => {
          void c.keepAwake(promise);
        },
      });
      return { state, object: createObject(options, getHost(), key, database, state) };
    },
    onWake: async (c) => {
      await c.vars.state.prepareForEvent();
      await c.vars.state.scheduleStoredAlarm();
    },
    actions: {
      call: async (c, method: string, encodedArgs: string): Promise<string> => {
        await c.vars.state.prepareForEvent();
        return await encodeCommandOutcome(async () => {
          const command = (c.vars.object as Record<string, unknown>)[method];
          if (typeof command !== "function") {
            throw new Error(`Backoffice object command ${method} does not exist.`);
          }
          return (await command.apply(c.vars.object, parse(encodedArgs) as unknown[])) as unknown;
        });
      },
      alarm: async (c) => {
        const { state, object } = c.vars;
        await state.prepareForEvent();
        const alarm = state.dueAlarm(Date.now());
        // A schedule an earlier alarm left behind finds none due.
        if (alarm) {
          await state.deliverAlarm(alarm, Date.now(), async () => {
            await (object as { alarm?: () => Promise<void> }).alarm?.();
          });
        }
      },
    },
    onRequest: async (c, request) => {
      await c.vars.state.prepareForEvent();
      return await (c.vars.object as { fetch(request: Request): Promise<Response> }).fetch(request);
    },
  });
}

/**
 * Copies the object's Cloudflare Durable Object into the actor's empty SQLite, in one transaction
 * so a failed or interrupted copy leaves nothing, and Cloudflare stops serving it. Runs on every
 * start; the storage tables mark a database that is already in place.
 */
async function importCloudflareObject(
  database: SqliteDatabase,
  key: RivetObjectKey,
  cloudflare: CloudflareObjectSource | null,
): Promise<void> {
  const imported = await executeRivetSqlite(
    database,
    `SELECT 1 FROM sqlite_master WHERE name = '__do_meta'`,
  );
  if (imported.length > 0) {
    return;
  }
  const transaction = await database.beginTransaction(undefined, "cloudflare-import");
  try {
    if (cloudflare) {
      // Child rows can arrive before their parents; foreign keys are checked at commit.
      await transaction.execute("PRAGMA defer_foreign_keys = ON");
      for await (const statements of exportCloudflareObject(cloudflare, key)) {
        for (const statement of statements) {
          await transaction.exec(statement);
        }
      }
    } else {
      for (const statement of RIVET_DURABLE_OBJECT_TABLES) {
        await transaction.exec(statement);
      }
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/**
 * Pages of the SQL that recreates the object, from the Durable Object migrator in the objects
 * Worker. Its client sends only an ID, which does not carry the name Backoffice objects read their
 * address from, so the object is named in each request, as is its jurisdiction.
 */
async function* exportCloudflareObject(
  cloudflare: CloudflareObjectSource,
  key: RivetObjectKey,
): AsyncGenerator<string[]> {
  const { id } = await callCloudflareMigrator<{ id: string }>(cloudflare, key, "resolve", {});
  let cursor: string | null = "";
  while (cursor !== null) {
    const page: { statements: string[]; cursor: string | null } = await callCloudflareMigrator(
      cloudflare,
      key,
      "export",
      cursor ? { id, cursor } : { id },
    );
    yield page.statements;
    cursor = page.cursor;
  }
}

async function callCloudflareMigrator<TResult>(
  cloudflare: CloudflareObjectSource,
  key: RivetObjectKey,
  action: "resolve" | "export",
  query: Record<string, string>,
): Promise<TResult> {
  const url = new URL(
    `/__migrate/${encodeURIComponent(key.binding)}/${action}`,
    cloudflare.workerUrl,
  );
  url.searchParams.set("name", key.name);
  if (key.jurisdiction) {
    url.searchParams.set("jurisdiction", key.jurisdiction);
  }
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  const response = await fetch(url, { headers: { authorization: `Bearer ${cloudflare.token}` } });
  if (!response.ok) {
    // A `migrator.dirty` export fails the actor's start; Rivet starts it again, and it copies anew.
    throw new Error(
      `The Durable Object migrator could not ${action} ${key.binding} ${key.name}: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as TResult;
}

function createObject(
  options: RivetBackofficeHostOptions,
  {
    services,
    factory: objects,
  }: { services: BackofficeRuntimeServices; factory: RivetObjectFactory },
  key: RivetObjectKey,
  database: SqliteDatabase,
  state: RivetDurableObjectState,
): unknown {
  const factory = options.objects[key.binding];
  if (!factory) {
    throw new Error(`Backoffice object binding ${key.binding} is not hosted on Rivet.`);
  }
  const runtime: BackofficeRuntimeServices = {
    ...services,
    adapters: actorDatabaseAdapters(database),
  };
  return factory({
    id: state.id,
    name: key.name,
    state,
    env: options.runtimeEnv,
    runtime,
    implementation: createNodeBackofficeObjectImplementation({
      state,
      env: options.runtimeEnv,
      runtime,
      telemetry: discardBackofficeTelemetry,
      // Like a Durable Object, the actor processes its durable hooks on its alarm.
      configuredObjectLifecycle: noOpBackofficeConfiguredObjectLifecycle,
    }),
    nowEpochMs: Date.now,
    createSandboxProviders: options.createSandboxProviders,
    getAuthDatabase: () => new Kysely<AuthDatabase>({ dialect: new RivetSqliteDialect(database) }),
    getPiAgent: (address) => objects.piAgentCommands(address),
    piAgentIdFromConfig: (config) =>
      ({ name: piAgentObjectName(config) }) as unknown as DurableObjectId,
    // Pi's tables sit beside the object's own, as on Cloudflare.
    openPiSessionStore: async () =>
      await SqliteStorage.open(rivetChordSqlite(database), { prefix: "pi_" }),
    piAvailableModels: null,
  });
}

/** Every Fragment database of an actor's object shares the actor's SQLite, as on Cloudflare. */
function actorDatabaseAdapters(database: SqliteDatabase): BackofficeDatabaseAdapterFactory {
  const adapters: BackofficeDatabaseAdapterFactory = {
    createAdapter: () =>
      new SqlAdapter({
        dialect: new RivetSqliteDialect(database),
        driverConfig: new BetterSQLite3DriverConfig(),
      }),
    forScope: () => adapters,
  };
  return adapters;
}

type RivetObjectHandle = {
  call(method: string, encodedArgs: string): Promise<string>;
  fetch(request: Request): Promise<Response>;
};

/** Reaches each object through its actor, as the Cloudflare factory reaches Durable Objects. */
class RivetObjectFactory implements BackofficeObjectFactory {
  readonly #getHandle: (key: RivetObjectKey) => RivetObjectHandle;
  readonly #env: BackofficeRuntimeEnv;

  constructor(getHandle: (key: RivetObjectKey) => RivetObjectHandle, env: BackofficeRuntimeEnv) {
    this.#getHandle = getHandle;
    this.#env = env;
  }

  get<TCommands>(
    binding: BackofficeObjectBinding<TCommands>,
    address: BackofficeObjectAddress,
  ): BackofficeObjectHandle<TCommands> {
    if (address.binding !== binding.name) {
      throw new Error(
        `Backoffice object address binding ${address.binding} does not match requested binding ${binding.name}.`,
      );
    }
    assertBackofficeObjectAddressAllowed(address);
    const handle = this.#getHandle({
      binding: binding.name,
      name: encodeBackofficeObjectAddress(address),
      jurisdiction: objectAddressJurisdiction(address) ?? "",
    });
    const http: BackofficeObjectHttp = {
      fetch: async (request) => await handle.fetch(removeBackofficeInternalContextHeader(request)),
      fetchAuthorized: async (request, context) =>
        await handle.fetch(
          await createAuthorizedBackofficeObjectRequest({
            request,
            address,
            context: {
              execution: context.execution,
              propagationContext: context.propagationContext ?? null,
            },
            env: this.#env as unknown as CloudflareEnv,
          }),
        ),
    };
    return { commands: commandsOf(handle) as TCommands, http };
  }

  piAgent(agent: PiAgentAddress): Pick<BackofficeObjectHttp, "fetchAuthorized"> {
    const handle = this.#piAgentHandle(agent);
    return {
      fetchAuthorized: async (request, context) =>
        await handle.fetch(
          await createAuthorizedBackofficeObjectRequest({
            request,
            address: { binding: "PI", agent },
            context: {
              execution: context.execution,
              propagationContext: context.propagationContext ?? null,
            },
            env: this.#env as unknown as CloudflareEnv,
          }),
        ),
    };
  }

  /** The commands Pi Manager gives its agents, which Cloudflare reaches through the PI binding. */
  piAgentCommands(agent: PiAgentAddress): PiAgent {
    return commandsOf(this.#piAgentHandle(agent)) as PiAgent;
  }

  #piAgentHandle(agent: PiAgentAddress): RivetObjectHandle {
    return this.#getHandle({
      binding: "PI",
      name: piAgentObjectName(agent),
      jurisdiction: backofficeScopeJurisdiction(agent.scope) ?? "",
    });
  }
}

/** Every command is an action; awaiting or inspecting the commands calls none. */
function commandsOf(handle: RivetObjectHandle): object {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        property === "then" || typeof property === "symbol"
          ? undefined
          : async (...args: unknown[]) =>
              decodeCommandOutcome(await handle.call(property, stringify(args))),
    },
  );
}

async function encodeCommandOutcome(run: () => Promise<unknown>): Promise<string> {
  let outcome: EncodedCommandOutcome;
  try {
    outcome = { ok: true, value: await run() };
  } catch (error) {
    // Rivet hides the messages of errors actions throw.
    const { name, message, stack } =
      error instanceof Error ? error : new Error(String(error), { cause: error });
    outcome = { ok: false, error: { name, message, stack: stack ?? null } };
  }
  return stringify(outcome);
}

function decodeCommandOutcome(encoded: string): unknown {
  const outcome = parse(encoded) as EncodedCommandOutcome;
  if (outcome.ok) {
    return outcome.value;
  }
  const error = new Error(outcome.error.message);
  error.name = outcome.error.name;
  if (outcome.error.stack) {
    error.stack = outcome.error.stack;
  }
  throw error;
}

function parseRivetObjectKey(key: string[]): RivetObjectKey {
  const [binding, name, jurisdiction] = key;
  if (!binding || name === undefined || jurisdiction === undefined) {
    throw new Error(`Malformed Rivet Backoffice object key: ${JSON.stringify(key)}`);
  }
  return { binding: binding as LocalObjectBindingName, name, jurisdiction };
}
