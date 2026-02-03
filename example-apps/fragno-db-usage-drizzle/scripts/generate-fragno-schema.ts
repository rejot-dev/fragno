import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { internalSchema } from "@fragno-dev/db";
import { InMemoryAdapter } from "@fragno-dev/db/adapters/in-memory";
import { generateDrizzleSchema } from "@fragno-dev/db/schema-output/drizzle";
import { defaultNamingStrategyForDatabase, type SupportedDatabase } from "@fragno-dev/db/drivers";
import type { AnySchema } from "@fragno-dev/db/schema";
import { createAuthFragment } from "@fragno-dev/auth";
import { createCommentFragment } from "@fragno-dev/fragno-db-library";
import { createRatingFragment } from "@fragno-dev/fragno-db-library/upvote";
import { createWorkflowsFragment } from "@fragno-dev/fragment-workflows";
import { defaultFragnoRuntime } from "@fragno-dev/core";

const supportedDialects: SupportedDatabase[] = ["postgresql", "sqlite", "mysql"];

const parseArgs = (args: string[]) => {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      values.set(arg, next);
      i++;
    }
  }
  return values;
};

type FragmentSchema = { schema: AnySchema; namespace: string | null };

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const dialect = args.get("--dialect");
  const outputPath = args.get("--out");

  if (!dialect || !supportedDialects.includes(dialect as SupportedDatabase)) {
    throw new Error(
      `Invalid --dialect. Use one of: ${supportedDialects.join(", ")}. Received: ${dialect ?? "(none)"}`,
    );
  }
  if (!outputPath) {
    throw new Error("Missing --out output path.");
  }

  process.env["FRAGNO_INIT_DRY_RUN"] = "true";

  try {
    const adapter = new InMemoryAdapter();

    const authFragment = createAuthFragment(
      {},
      { databaseAdapter: adapter, databaseNamespace: "auth" },
    );
    const commentFragment = createCommentFragment({}, { databaseAdapter: adapter });
    const ratingFragment = createRatingFragment({}, { databaseAdapter: adapter });
    const workflowsFragment = createWorkflowsFragment(
      { runtime: defaultFragnoRuntime, workflows: {}, enableRunnerTick: false },
      { databaseAdapter: adapter },
    );

    const fragments: FragmentSchema[] = [
      authFragment,
      commentFragment,
      ratingFragment,
      workflowsFragment,
    ].map((fragment) => {
      const deps = fragment.$internal.deps as { schema: AnySchema; namespace: string | null };
      return { schema: deps.schema, namespace: deps.namespace ?? null };
    });

    const fragmentsMap = new Map<string, FragmentSchema>();
    fragmentsMap.set(internalSchema.name, { schema: internalSchema, namespace: null });
    for (const fragment of fragments) {
      const key = fragment.namespace ?? fragment.schema.name;
      if (!fragmentsMap.has(key)) {
        fragmentsMap.set(key, fragment);
      }
    }

    const schemaOutput = generateDrizzleSchema(
      Array.from(fragmentsMap.values()),
      dialect as SupportedDatabase,
      {
        namingStrategy: defaultNamingStrategyForDatabase(dialect as SupportedDatabase),
      },
    );

    const finalPath = resolve(process.cwd(), outputPath);
    await writeFile(finalPath, schemaOutput, { encoding: "utf-8" });
    console.log(`✓ Generated: ${finalPath}`);
  } finally {
    delete process.env["FRAGNO_INIT_DRY_RUN"];
  }
};

await main();
