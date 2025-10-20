import { isFragnoDatabase, type FragnoDatabase } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";
import { writeFile, stat, mkdir } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import type { CommandContext } from "gunshi";

export async function generate(ctx: CommandContext) {
  const target = ctx.values["target"];
  const output = ctx.values["output"];
  const toVersion = ctx.values["to"];
  const fromVersion = ctx.values["from"];

  if (!target || typeof target !== "string") {
    throw new Error("Target file path is required and must be a string");
  }

  if (typeof output === "number" || typeof output === "boolean") {
    throw new Error("Output file path is required and must be a string");
  }

  if (toVersion !== undefined && typeof toVersion !== "string" && typeof toVersion !== "number") {
    throw new Error("Version must be a number or string");
  }

  if (
    fromVersion !== undefined &&
    typeof fromVersion !== "string" &&
    typeof fromVersion !== "number"
  ) {
    throw new Error("Version must be a number or string");
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
    throw new Error(`No FragnoDatabase instances found in ${target}.\n`);
  }

  if (fragnoDatabases.length > 1) {
    console.warn(
      `Warning: Multiple FragnoDatabase instances found (${fragnoDatabases.length}). Using the first one.`,
    );
  }

  // Use the first FragnoDatabase instance
  const fragnoDb = fragnoDatabases[0];

  // Parse versions if provided
  const targetVersion = toVersion !== undefined ? parseInt(String(toVersion), 10) : undefined;
  const sourceVersion = fromVersion !== undefined ? parseInt(String(fromVersion), 10) : undefined;

  if (targetVersion !== undefined && isNaN(targetVersion)) {
    throw new Error(`Invalid version number: ${toVersion}`);
  }

  if (sourceVersion !== undefined && isNaN(sourceVersion)) {
    throw new Error(`Invalid version number: ${fromVersion}`);
  }

  if (sourceVersion !== undefined && targetVersion !== undefined) {
    console.log(
      `Generating schema for namespace: ${fragnoDb.namespace} (from version ${sourceVersion} to version ${targetVersion})`,
    );
  } else if (targetVersion !== undefined) {
    console.log(
      `Generating schema for namespace: ${fragnoDb.namespace} (to version ${targetVersion})`,
    );
  } else if (sourceVersion !== undefined) {
    console.log(
      `Generating schema for namespace: ${fragnoDb.namespace} (from version ${sourceVersion})`,
    );
  } else {
    console.log(`Generating schema for namespace: ${fragnoDb.namespace}`);
  }

  // Determine if output is a directory or file
  let isDirectory = false;

  if (output) {
    const resolvedOutput = resolve(process.cwd(), output);
    try {
      const stats = await stat(resolvedOutput);
      isDirectory = stats.isDirectory();
    } catch {
      // Path doesn't exist - check if it looks like a directory (ends with /)
      isDirectory = output.endsWith("/");
    }
  }

  // Generate schema
  let result: { schema: string; path: string };
  try {
    // If output is a directory, pass undefined to get the default file name
    // Otherwise pass the output path as-is
    result = await fragnoDb.generateSchema({
      path: isDirectory ? undefined : output,
      toVersion: targetVersion,
      fromVersion: sourceVersion,
    });
  } catch (error) {
    throw new Error(
      `Failed to generate schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Resolve final output path
  let finalOutputPath: string;
  if (isDirectory && output) {
    // Combine directory with generated file name
    const resolvedDir = resolve(process.cwd(), output);
    finalOutputPath = join(resolvedDir, basename(result.path));
  } else if (output) {
    // Use the provided path as-is
    finalOutputPath = resolve(process.cwd(), output);
  } else {
    // Use the generated file name in current directory
    finalOutputPath = resolve(process.cwd(), result.path);
  }

  // Ensure parent directory exists
  const parentDir = dirname(finalOutputPath);
  try {
    await mkdir(parentDir, { recursive: true });
  } catch (error) {
    throw new Error(
      `Failed to create directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Write schema to file
  try {
    await writeFile(finalOutputPath, result.schema, { encoding: "utf-8" });
  } catch (error) {
    throw new Error(
      `Failed to write schema file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log(`✓ Schema generated successfully: ${finalOutputPath}`);
  console.log(`  Namespace: ${fragnoDb.namespace}`);
  console.log(`  Schema version: ${fragnoDb.schema.version}`);
}
