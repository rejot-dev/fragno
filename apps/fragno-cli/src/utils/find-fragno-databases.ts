import { isFragnoDatabase, type DatabaseAdapter, FragnoDatabase } from "@fragno-dev/db";
import {
  fragnoDatabaseAdapterNameFakeSymbol,
  fragnoDatabaseAdapterVersionFakeSymbol,
} from "@fragno-dev/db/adapters";
import type { AnySchema } from "@fragno-dev/db/schema";
import {
  instantiatedFragmentFakeSymbol,
  type FragnoInstantiatedFragment,
} from "@fragno-dev/core/api/fragment-instantiation";
import { loadConfig } from "c12";
import { relative } from "node:path";

export async function importFragmentFile(path: string): Promise<Record<string, unknown>> {
  const { config } = await loadConfig({
    configFile: path,
  });

  const databases = findFragnoDatabases(config);
  const adapterNames = databases.map(
    (db) =>
      `${db.adapter[fragnoDatabaseAdapterNameFakeSymbol]}@${db.adapter[fragnoDatabaseAdapterVersionFakeSymbol]}`,
  );
  const uniqueAdapterNames = [...new Set(adapterNames)];

  if (uniqueAdapterNames.length > 1) {
    throw new Error(
      `All Fragno databases must use the same adapter name and version. ` +
        `Found mismatch: (${adapterNames.join(", ")})`,
    );
  }

  return {
    adapter: databases[0].adapter,
    databases,
  };
}

/**
 * Imports multiple fragment files and validates they all use the same adapter.
 * Returns the combined databases from all files.
 */
export async function importFragmentFiles(paths: string[]): Promise<{
  adapter: DatabaseAdapter;
  databases: FragnoDatabase<AnySchema>[];
}> {
  // De-duplicate paths (in case same file was specified multiple times)
  const uniquePaths = Array.from(new Set(paths));

  if (uniquePaths.length === 0) {
    throw new Error("No fragment files provided");
  }

  const allDatabases: FragnoDatabase<AnySchema>[] = [];
  let adapter: DatabaseAdapter | undefined;
  let firstAdapterFile: string | undefined;
  const cwd = process.cwd();

  for (const path of uniquePaths) {
    const relativePath = relative(cwd, path);

    try {
      const result = await importFragmentFile(path);
      const databases = result["databases"] as FragnoDatabase<AnySchema>[];
      const fileAdapter = result["adapter"] as DatabaseAdapter;

      if (databases.length === 0) {
        console.warn(
          `Warning: No FragnoDatabase instances found in ${relativePath}.\n` +
            `Make sure you export either:\n` +
            `  - A FragnoDatabase instance created with .create(adapter)\n` +
            `  - An instantiated fragment with embedded database definition\n`,
        );
        continue;
      }

      // Set the adapter from the first file with databases
      if (!adapter) {
        adapter = fileAdapter;
        firstAdapterFile = relativePath;
      }

      // Validate all files use the same adapter name and version
      const firstAdapterName = adapter[fragnoDatabaseAdapterNameFakeSymbol];
      const firstAdapterVersion = adapter[fragnoDatabaseAdapterVersionFakeSymbol];
      const fileAdapterName = fileAdapter[fragnoDatabaseAdapterNameFakeSymbol];
      const fileAdapterVersion = fileAdapter[fragnoDatabaseAdapterVersionFakeSymbol];

      if (firstAdapterName !== fileAdapterName || firstAdapterVersion !== fileAdapterVersion) {
        const firstAdapterInfo = `${firstAdapterName}@${firstAdapterVersion}`;
        const fileAdapterInfo = `${fileAdapterName}@${fileAdapterVersion}`;

        throw new Error(
          `All fragments must use the same database adapter. Mixed adapters found:\n` +
            `  - ${firstAdapterFile}: ${firstAdapterInfo}\n` +
            `  - ${relativePath}: ${fileAdapterInfo}\n\n` +
            `Make sure all fragments use the same adapter name and version.`,
        );
      }

      allDatabases.push(...databases);
      console.log(`  Found ${databases.length} database(s) in ${relativePath}`);
    } catch (error) {
      throw new Error(
        `Failed to import fragment file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (allDatabases.length === 0) {
    throw new Error(
      `No FragnoDatabase instances found in any of the target files.\n` +
        `Make sure your files export either:\n` +
        `  - A FragnoDatabase instance created with .create(adapter)\n` +
        `  - An instantiated fragment with embedded database definition\n`,
    );
  }

  if (!adapter) {
    throw new Error("No adapter found in any of the fragment files");
  }

  return {
    adapter,
    databases: allDatabases,
  };
}

function isFragnoInstantiatedFragment(
  value: unknown,
): value is FragnoInstantiatedFragment<[], {}, {}, {}> {
  return (
    typeof value === "object" &&
    value !== null &&
    instantiatedFragmentFakeSymbol in value &&
    value[instantiatedFragmentFakeSymbol] === instantiatedFragmentFakeSymbol
  );
}

function additionalContextIsDatabaseContext(additionalContext: unknown): additionalContext is {
  databaseSchema: AnySchema;
  databaseNamespace: string;
  databaseAdapter: DatabaseAdapter;
} {
  return (
    typeof additionalContext === "object" &&
    additionalContext !== null &&
    "databaseSchema" in additionalContext &&
    "databaseNamespace" in additionalContext &&
    "databaseAdapter" in additionalContext
  );
}

/**
 * Finds all FragnoDatabase instances in a module, including those embedded
 * in instantiated fragments.
 */
export function findFragnoDatabases(
  targetModule: Record<string, unknown>,
): FragnoDatabase<AnySchema>[] {
  const fragnoDatabases: FragnoDatabase<AnySchema>[] = [];

  for (const [_key, value] of Object.entries(targetModule)) {
    if (isFragnoDatabase(value)) {
      fragnoDatabases.push(value);
    } else if (isFragnoInstantiatedFragment(value)) {
      const additionalContext = value.additionalContext;

      if (!additionalContext || !additionalContextIsDatabaseContext(additionalContext)) {
        continue;
      }

      // Extract database schema, namespace, and adapter from instantiated fragment's additionalContext
      const { databaseSchema, databaseNamespace, databaseAdapter } = additionalContext;

      fragnoDatabases.push(
        new FragnoDatabase({
          namespace: databaseNamespace,
          schema: databaseSchema,
          adapter: databaseAdapter,
        }),
      );
    }
  }

  return fragnoDatabases;
}
