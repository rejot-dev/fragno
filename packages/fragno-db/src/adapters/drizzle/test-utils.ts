import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { generateSchema, type SupportedProvider } from "./generate";
import type { Schema } from "../../schema/create";
import { internalSchema } from "../../fragments/internal-fragment";

/**
 * Writes a Fragno schema to a temporary TypeScript file and dynamically imports it.
 * This is used in tests to create Drizzle schema modules from Fragno schemas.
 *
 * Each test gets its own isolated directory to prevent interference.
 *
 * @param testFileName - Name of the test file (used to create an isolated subdirectory)
 * @param schema - The Fragno schema to convert
 * @param dialect - The database dialect (postgresql, mysql, sqlite)
 * @returns An object containing the imported schema module, file path, and cleanup function
 */
export async function writeAndLoadSchema(
  testFileName: string,
  schema: Schema,
  dialect: SupportedProvider,
  namespace?: string,
  includeInternalSchema: boolean = true,
) {
  // Create test-specific directory inside _generated
  const baseDir = join(import.meta.dirname, "_generated");
  const testDir = join(baseDir, testFileName);

  // Ensure test directory exists (with error handling for race conditions)
  try {
    await mkdir(testDir, { recursive: true });
  } catch {
    //
  }

  // Generate unique schema file path
  const schemaFilePath = join(
    testDir,
    `test-schema-${testFileName}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.ts`,
  );

  // Generate and write the Drizzle schema to file
  // Always include settings schema first (as done in generation-engine.ts), then the test schema
  // De-duplicate: if the test schema IS the settings schema, don't add it twice
  const fragments: Array<{ namespace: string; schema: Schema }> = [];

  if (includeInternalSchema) {
    fragments.push({ namespace: "", schema: internalSchema });
  }

  if (schema !== internalSchema) {
    fragments.push({ namespace: namespace ?? "", schema });
  }

  const drizzleSchemaTs = generateSchema(fragments, dialect);
  await writeFile(schemaFilePath, drizzleSchemaTs, "utf-8");

  // Ensure the file is accessible before importing (handle race conditions)
  let retries = 0;
  const maxRetries = 10;
  while (retries < maxRetries) {
    try {
      await access(schemaFilePath);
      break;
    } catch {
      if (retries === maxRetries - 1) {
        throw new Error(`Schema file was not accessible after writing: ${schemaFilePath}`);
      }
      // Wait a bit before retrying
      await new Promise((resolve) => setTimeout(resolve, 10));
      retries++;
    }
  }

  // Dynamically import the generated schema (with cache busting)
  const schemaModule = await import(`${schemaFilePath}?t=${Date.now()}`);

  // Cleanup function to remove the test-specific directory
  const cleanup = async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore error if directory doesn't exist
    }
  };

  return {
    schemaModule,
    schemaFilePath,
    drizzleSchemaTs,
    cleanup,
  };
}
