import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { define } from "gunshi";
import { findFragnoDatabases } from "../../utils/find-fragno-databases";
import type { FragnoDatabase } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";
import { generateMigrationsOrSchema } from "@fragno-dev/db/generation-engine";

// Define the db generate command with type safety
export const generateCommand = define({
  name: "generate",
  description: "Generate schema files from FragnoDatabase definitions",
  args: {
    output: {
      type: "string",
      short: "o",
      description:
        "Output path: for single file, exact file path; for multiple files, output directory (default: current directory)",
    },
    from: {
      type: "number",
      short: "f",
      description: "Source version to generate migration from (default: current database version)",
    },
    to: {
      type: "number",
      short: "t",
      description: "Target version to generate migration to (default: latest schema version)",
    },
    prefix: {
      type: "string",
      short: "p",
      description: "String to prepend to the generated file (e.g., '/* eslint-disable */')",
    },
  },
  run: async (ctx) => {
    // With `define()` and `multiple: true`, targets is properly typed as string[]
    const targets = ctx.positionals;
    const output = ctx.values.output;
    const toVersion = ctx.values.to;
    const fromVersion = ctx.values.from;
    const prefix = ctx.values.prefix;

    // De-duplicate targets (in case same file was specified multiple times)
    const uniqueTargets = Array.from(new Set(targets));

    // Load all target files and collect FragnoDatabase instances
    const allFragnoDatabases: FragnoDatabase<AnySchema>[] = [];

    for (const target of uniqueTargets) {
      const targetPath = resolve(process.cwd(), target);
      console.log(`Loading target file: ${targetPath}`);

      // Dynamically import the target file
      let targetModule: Record<string, unknown>;
      try {
        targetModule = await import(targetPath);
      } catch (error) {
        throw new Error(
          `Failed to import target file ${target}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Find all FragnoDatabase instances or instantiated fragments with databases
      const fragnoDatabases = findFragnoDatabases(targetModule);

      if (fragnoDatabases.length === 0) {
        console.warn(
          `Warning: No FragnoDatabase instances found in ${target}.\n` +
            `Make sure you export either:\n` +
            `  - A FragnoDatabase instance created with .create(adapter)\n` +
            `  - An instantiated fragment with embedded database definition\n`,
        );
        continue;
      }

      if (fragnoDatabases.length > 1) {
        console.warn(
          `Warning: Multiple FragnoDatabase instances found in ${target} (${fragnoDatabases.length}). Using all of them.`,
        );
      }

      allFragnoDatabases.push(...fragnoDatabases);
    }

    if (allFragnoDatabases.length === 0) {
      throw new Error(
        `No FragnoDatabase instances found in any of the target files.\n` +
          `Make sure your files export either:\n` +
          `  - A FragnoDatabase instance created with .create(adapter)\n` +
          `  - An instantiated fragment with embedded database definition\n`,
      );
    }

    console.log(
      `Found ${allFragnoDatabases.length} FragnoDatabase instance(s) across ${uniqueTargets.length} file(s)`,
    );

    // Validate all databases use the same adapter object (identity)
    const firstDb = allFragnoDatabases[0];
    const firstAdapter = firstDb.adapter;
    const allSameAdapter = allFragnoDatabases.every((db) => db.adapter === firstAdapter);

    if (!allSameAdapter) {
      throw new Error(
        "All fragments must use the same database adapter instance. Mixed adapters are not supported.",
      );
    }

    // Check if adapter supports any form of schema generation
    if (!firstDb.adapter.createSchemaGenerator && !firstDb.adapter.createMigrationEngine) {
      throw new Error(
        `The adapter does not support schema generation. ` +
          `Please use an adapter that implements either createSchemaGenerator or createMigrationEngine.`,
      );
    }

    // Generate schema for all fragments
    console.log("Generating schema...");

    let results: { schema: string; path: string; namespace: string }[];
    try {
      results = await generateMigrationsOrSchema(allFragnoDatabases, {
        path: output,
        toVersion,
        fromVersion,
      });
    } catch (error) {
      throw new Error(
        `Failed to generate schema: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Write all generated files
    for (const result of results) {
      // For single file: use output as exact file path
      // For multiple files: use output as base directory
      const finalOutputPath =
        output && results.length === 1
          ? resolve(process.cwd(), output)
          : output
            ? resolve(process.cwd(), output, result.path)
            : resolve(process.cwd(), result.path);

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
        const content = prefix ? `${prefix}\n${result.schema}` : result.schema;
        await writeFile(finalOutputPath, content, { encoding: "utf-8" });
      } catch (error) {
        throw new Error(
          `Failed to write schema file: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      console.log(`✓ Generated: ${finalOutputPath}`);
    }

    console.log(`\n✓ Schema generated successfully!`);
    console.log(`  Files generated: ${results.length}`);
    console.log(`  Fragments:`);
    for (const db of allFragnoDatabases) {
      console.log(`    - ${db.namespace} (version ${db.schema.version})`);
    }
  },
});
