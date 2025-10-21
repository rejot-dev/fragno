import { isFragnoDatabase, type DatabaseAdapter, FragnoDatabase } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";
import {
  instantiatedFragmentFakeSymbol,
  type FragnoInstantiatedFragment,
} from "@fragno-dev/core/api/fragment-instantiation";

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

  for (const [key, value] of Object.entries(targetModule)) {
    if (isFragnoDatabase(value)) {
      fragnoDatabases.push(value);
      console.log(`Found FragnoDatabase instance: ${key}`);
    } else if (isFragnoInstantiatedFragment(value)) {
      const additionalContext = value.additionalContext;

      if (!additionalContext || !additionalContextIsDatabaseContext(additionalContext)) {
        console.warn(`Instantiated fragment ${key} has no database context`);
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
      console.log(`Found database context in instantiated fragment: ${key}`);
    }
  }

  return fragnoDatabases;
}
