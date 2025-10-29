import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateSchema, type SupportedProvider } from "./generate";
import type { Schema } from "../../schema/create";

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
    `test-schema-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.ts`,
  );

  // Generate and write the Drizzle schema to file
  // Use empty namespace for tests to avoid table name prefixing
  const drizzleSchemaTs = generateSchema([{ namespace: namespace ?? "", schema }], dialect);
  await writeFile(schemaFilePath, drizzleSchemaTs, "utf-8");

  // Dynamically import the generated schema (with cache busting)
  const schemaModule = await import(`${schemaFilePath}?t=${Date.now()}`);

  // Cleanup function to remove the test-specific directory
  const cleanup = async () => {
    await rm(testDir, { recursive: true, force: true });
  };

  return {
    schemaModule,
    schemaFilePath,
    drizzleSchemaTs,
    cleanup,
  };
}
