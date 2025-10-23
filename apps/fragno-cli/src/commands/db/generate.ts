import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { define } from "gunshi";
import { findFragnoDatabases } from "../../utils/find-fragno-databases";
import type { FragnoDatabase } from "@fragno-dev/db";
import type { AnySchema } from "@fragno-dev/db/schema";

// Define the db generate command with type safety
export const generateCommand = define({
  name: "generate",
  description: "Generate schema files from FragnoDatabase definitions",
  args: {
    output: {
      type: "string",
      short: "o",
      description:
        "Output path for the generated schema file (default: schema.sql for Kysely, fragno-schema.ts for Drizzle)",
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

    // Check if adapter supports schema generation
    if (!firstDb.adapter.createSchemaGenerator) {
      throw new Error(
        `The adapter does not support schema generation. ` +
          `Please use an adapter that implements the createSchemaGenerator method.`,
      );
    }

    // Validate versions are not used when generating schemas for multiple fragments
    if ((toVersion !== undefined || fromVersion !== undefined) && allFragnoDatabases.length > 1) {
      console.warn(
        "⚠️ Warning: --from and --to version options are not supported when generating schemas for multiple fragments and will be ignored.",
      );
    }

    // Generate schema for all fragments using the adapter
    console.log("Generating schema...");

    // Prepare fragments for generation
    const fragments = allFragnoDatabases.map((db) => ({
      namespace: db.namespace,
      schema: db.schema,
    }));

    // Generate the combined schema through the adapter
    let result: { schema: string; path: string };
    try {
      const schemaGenerator = firstDb.adapter.createSchemaGenerator(fragments, {
        path: output,
      });
      result = schemaGenerator.generateSchema();
    } catch (error) {
      throw new Error(
        `Failed to generate schema: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Determine output path
    const finalOutputPath = output
      ? resolve(process.cwd(), output)
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

    console.log(`✓ Schema generated successfully: ${finalOutputPath}`);
    console.log(`  Fragments:`);
    for (const db of allFragnoDatabases) {
      console.log(`    - ${db.namespace} (version ${db.schema.version})`);
    }
  },
});
