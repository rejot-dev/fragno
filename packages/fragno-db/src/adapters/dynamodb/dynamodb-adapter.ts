import { RequestContextStorage } from "@fragno-dev/core/internal/request-context-storage";

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { internalSchema } from "../../fragments/internal-fragment.schema";
import { FragnoDatabase } from "../../fragno-database";
import { getOutboxConfigForAdapter } from "../../internal/outbox-state";
import { suffixNamingStrategy, type SqlNamingStrategy } from "../../naming/sql-naming";
import type {
  CompiledMutation,
  UOWInstrumentation,
  UnitOfWorkConfig as BaseUnitOfWorkConfig,
} from "../../query/unit-of-work/unit-of-work";
import { UnitOfWork } from "../../query/unit-of-work/unit-of-work";
import type { AnySchema } from "../../schema/create";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
  type DatabaseAdapter,
  type DatabaseAdapterMetadata,
  type DatabaseContextStorage,
} from "../adapters";
import { createUOWCompilerFromOperationCompiler } from "../shared/uow-operation-compiler";
import { createDynamoDBLayout } from "./dynamodb-layout";
import { DynamoDBUOWDecoder } from "./dynamodb-uow-decoder";
import { DynamoDBUOWExecutor } from "./dynamodb-uow-executor";
import {
  DynamoDBUOWOperationCompiler,
  type DynamoDBCommandPlan,
} from "./dynamodb-uow-operation-compiler";
import { createDynamoDBPreparedMigrations } from "./migration/prepared-migrations";

export interface DynamoDBAdapterOptions {
  client: DynamoDBDocumentClient;
  tablePrefix?: string;
  namingStrategy?: SqlNamingStrategy;
  consistentRead?: boolean;
  maxFilteredReadPages?: number;
  allowScans?: boolean;
  uowConfig?: DynamoDBUnitOfWorkConfig;
}

export interface DynamoDBUnitOfWorkConfig {
  dryRun?: boolean;
  instrumentation?: UOWInstrumentation;
  onCommand?: (command: DynamoDBCommandPlan) => void;
  consistentRead?: boolean;
  maxFilteredReadPages?: number;
  allowScans?: boolean;
}

export class DynamoDBAdapter implements DatabaseAdapter<DynamoDBUnitOfWorkConfig> {
  readonly client: DynamoDBDocumentClient;
  readonly tablePrefix?: string;
  readonly namingStrategy: SqlNamingStrategy;
  readonly adapterMetadata: DatabaseAdapterMetadata = {};
  readonly uowConfig?: DynamoDBUnitOfWorkConfig;
  readonly consistentRead: boolean;
  readonly maxFilteredReadPages: number;
  readonly allowScans: boolean;

  #contextStorage: RequestContextStorage<DatabaseContextStorage>;
  #schemaNamespaceMap = new WeakMap<AnySchema, string | null>();

  constructor(options: DynamoDBAdapterOptions) {
    this.client = options.client;
    this.tablePrefix = options.tablePrefix;
    this.namingStrategy = options.namingStrategy ?? suffixNamingStrategy;
    this.consistentRead = options.consistentRead ?? true;
    this.maxFilteredReadPages = options.maxFilteredReadPages ?? 10;
    this.allowScans = options.allowScans ?? false;
    this.uowConfig = options.uowConfig;
    this.#contextStorage = new RequestContextStorage();
  }

  get [fragnoDatabaseAdapterNameFakeSymbol](): string {
    return "dynamodb";
  }

  get [fragnoDatabaseAdapterVersionFakeSymbol](): number {
    return 1;
  }

  get contextStorage(): RequestContextStorage<DatabaseContextStorage> {
    return this.#contextStorage;
  }

  prepareMigrations<T extends AnySchema>(schema: T, namespace: string | null) {
    return createDynamoDBPreparedMigrations({
      client: this.client,
      schema,
      namespace,
      tablePrefix: this.tablePrefix,
      namingStrategy: this.namingStrategy,
    });
  }

  async getSchemaVersion(namespace: string): Promise<string | undefined> {
    const migrations = createDynamoDBPreparedMigrations({
      client: this.client,
      schema: {
        name: namespace,
        version: 0,
        tables: {},
        operations: [],
        clone: () => {
          throw new Error("schema placeholder cannot be cloned");
        },
      },
      namespace,
      tablePrefix: this.tablePrefix,
      namingStrategy: this.namingStrategy,
    });
    return migrations.getSchemaVersion(namespace);
  }

  async isConnectionHealthy(): Promise<boolean> {
    const migrations = createDynamoDBPreparedMigrations({
      client: this.client,
      schema: {
        name: "health",
        version: 0,
        tables: {},
        operations: [],
        clone: () => {
          throw new Error("schema placeholder cannot be cloned");
        },
      },
      namespace: "health",
      tablePrefix: this.tablePrefix,
      namingStrategy: this.namingStrategy,
    });
    return migrations.isConnectionHealthy();
  }

  async close(): Promise<void> {
    return;
  }

  registerSchema<T extends AnySchema>(schema: T, namespace: string | null): void {
    this.#schemaNamespaceMap.set(schema, namespace);
  }

  createUnitOfWork<T extends AnySchema>(
    schema: T,
    namespace: string | null,
    name?: string,
    config?: DynamoDBUnitOfWorkConfig,
  ): ReturnType<FragnoDatabase<T, DynamoDBUnitOfWorkConfig>["createUnitOfWork"]> {
    this.registerSchema(schema, namespace);
    return this.createBaseUnitOfWork(name, config).forSchema(schema);
  }

  createBaseUnitOfWork(
    name?: string,
    config?: DynamoDBUnitOfWorkConfig,
  ): ReturnType<FragnoDatabase<AnySchema, DynamoDBUnitOfWorkConfig>["createBaseUnitOfWork"]> {
    const compiler = createUOWCompilerFromOperationCompiler(
      new DynamoDBUOWOperationCompiler({ tablePrefix: this.tablePrefix }),
    );
    const mergedConfig = { ...this.uowConfig, ...config };
    const settingsTableName = createDynamoDBLayout({
      schema: createAdapterMetadataSchema(),
      namespace: null,
      tablePrefix: this.tablePrefix,
      namingStrategy: this.namingStrategy,
    }).settingsTableName;
    const internalLayout = createDynamoDBLayout({
      schema: internalSchema,
      namespace: null,
      tablePrefix: this.tablePrefix,
      namingStrategy: this.namingStrategy,
    });
    const executor = new DynamoDBUOWExecutor({
      client: this.client,
      settingsTableName,
      consistentRead: mergedConfig.consistentRead ?? this.consistentRead,
      maxFilteredReadPages: mergedConfig.maxFilteredReadPages ?? this.maxFilteredReadPages,
      allowScans: mergedConfig.allowScans ?? this.allowScans,
      outbox: getOutboxConfigForAdapter(this),
      internalTableLayouts: Object.fromEntries(
        Object.values(internalSchema.tables).map((table) => [
          table.name,
          internalLayout.getTableLayout(table),
        ]),
      ),
    });
    const decoder = new DynamoDBUOWDecoder();

    return new UnitOfWork(
      compiler,
      executor,
      decoder,
      name,
      this.#normalizeUowConfig(mergedConfig),
      this.#schemaNamespaceMap,
    );
  }

  createQueryEngine<T extends AnySchema>(
    schema: T,
    namespace: string | null,
  ): FragnoDatabase<T, DynamoDBUnitOfWorkConfig> {
    this.registerSchema(schema, namespace);
    return new FragnoDatabase({ adapter: this, schema, namespace });
  }

  #normalizeUowConfig(config?: DynamoDBUnitOfWorkConfig): BaseUnitOfWorkConfig | undefined {
    if (!config) {
      return undefined;
    }
    const {
      onCommand,
      consistentRead: _consistentRead,
      maxFilteredReadPages: _maxFilteredReadPages,
      allowScans: _allowScans,
      ...rest
    } = config;
    return {
      ...rest,
      onQuery: onCommand ? (query) => onCommand(extractCommandPlan(query)) : undefined,
    };
  }
}

function createAdapterMetadataSchema(): AnySchema {
  return {
    name: "dynamodb_adapter",
    version: 0,
    tables: {},
    operations: [],
    clone: createAdapterMetadataSchema,
  };
}

function extractCommandPlan(query: unknown): DynamoDBCommandPlan {
  if (query && typeof query === "object" && "query" in query) {
    return (query as CompiledMutation<DynamoDBCommandPlan>).query;
  }
  return query as DynamoDBCommandPlan;
}
