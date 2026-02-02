import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { define } from "gunshi";
import { generateSchemaArtifacts } from "@fragno-dev/db/generation-engine";
import { importFragmentFiles } from "../../utils/find-fragno-databases";

// Define the db generate command with type safety
export const generateCommand = define({
  name: "generate",
  description: "Generate SQL migrations or schema outputs from FragnoDatabase definitions",
  args: {
    format: {
      type: "string",
      description: "Output format: sql (migrations), drizzle (schema), prisma (schema)",
    },
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
    const format = ctx.values.format ?? "sql";
    const toVersion = ctx.values.to;
    const fromVersion = ctx.values.from;
    const prefix = ctx.values.prefix;

    // Resolve all target paths
    const targetPaths = targets.map((target) => resolve(process.cwd(), target));

    // Import all fragment files and validate they use the same adapter
    const { databases: allFragnoDatabases } = await importFragmentFiles(targetPaths);

    const allowedFormats = ["sql", "drizzle", "prisma"] as const;
    if (!allowedFormats.includes(format as (typeof allowedFormats)[number])) {
      throw new Error(`Unsupported format '${format}'. Use one of: ${allowedFormats.join(", ")}.`);
    }

    if (format !== "sql" && (toVersion !== undefined || fromVersion !== undefined)) {
      throw new Error("--from and --to are only supported for SQL migration output.");
    }

    // Generate schema for all fragments
    if (format === "sql") {
      console.log("Generating SQL migrations...");
    } else {
      console.log(`Generating ${format} schema output...`);
    }

    let results: { schema: string; path: string; namespace: string }[];
    try {
      results = await generateSchemaArtifacts(allFragnoDatabases, {
        format: format as "sql" | "drizzle" | "prisma",
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

    console.log(`\n✓ Output generated successfully!`);
    console.log(`  Files generated: ${results.length}`);
    console.log(`  Fragments:`);
    for (const db of allFragnoDatabases) {
      console.log(`    - ${db.namespace} (version ${db.schema.version})`);
    }
  },
});
