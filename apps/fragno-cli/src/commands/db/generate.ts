import { isFragnoDatabase, type FragnoDatabase } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandContext } from "gunshi";

export async function generate(ctx: CommandContext) {
  const target = ctx.values["target"];
  const output = ctx.values["output"];

  if (!target || typeof target !== "string") {
    throw new Error("Target file path is required and must be a string");
  }

  if (typeof output === "number" || typeof output === "boolean") {
    throw new Error("Output file path is required and must be a string");
  }

  // Resolve the target file path relative to current working directory
  const targetPath = resolve(process.cwd(), target);

  console.log(`Loading target file: ${targetPath}`);

  // Dynamically import the target file
  let targetModule: Record<string, unknown>;
  try {
    targetModule = await import(targetPath);
  } catch (error) {
    throw new Error(
      `Failed to import target file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Find all FragnoDatabase instances in the exported values
  const fragnoDatabases: FragnoDatabase<AnySchema>[] = [];

  for (const [key, value] of Object.entries(targetModule)) {
    if (isFragnoDatabase(value)) {
      fragnoDatabases.push(value);
      console.log(`Found FragnoDatabase instance: ${key}`);
    }
  }

  if (fragnoDatabases.length === 0) {
    throw new Error(
      `No FragnoDatabase instances found in ${target}.\n` +
        `Make sure you export a FragnoDatabase instance that has been bound using withAdapter().\n` +
        `Example: export const boundDb = myDb.withAdapter(adapter);`,
    );
  }

  if (fragnoDatabases.length > 1) {
    console.warn(
      `Warning: Multiple FragnoDatabase instances found (${fragnoDatabases.length}). Using the first one.`,
    );
  }

  // Use the first FragnoDatabase instance
  const fragnoDb = fragnoDatabases[0];

  console.log(`Generating schema for namespace: ${fragnoDb.namespace}`);

  // Generate schema
  let result: { schema: string; path: string };
  try {
    result = await fragnoDb.generateSchemaAsync({ path: output });
  } catch (error) {
    throw new Error(
      `Failed to generate schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Resolve output path relative to current working directory
  const finalOutputPath = resolve(process.cwd(), result.path);

  // Write schema to file
  try {
    writeFileSync(finalOutputPath, result.schema, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to write schema file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log(`✓ Schema generated successfully: ${finalOutputPath}`);
  console.log(`  Namespace: ${fragnoDb.namespace}`);
  console.log(`  Schema version: ${fragnoDb.schema.version}`);
}
