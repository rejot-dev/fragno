import { define } from "gunshi";
import { getSubjects, getSubject } from "@fragno-private/corpus";

/**
 * Print a subject with its examples
 */
function printSubject(subject: ReturnType<typeof getSubject>[number]): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${subject.title}`);
  console.log(`${"=".repeat(60)}\n`);

  if (subject.description) {
    console.log(subject.description);
    console.log();
  }

  // Print imports block if present
  if (subject.imports) {
    console.log("### Imports\n");
    console.log("```typescript");
    console.log(subject.imports);
    console.log("```\n");
  }

  // Print init block if present
  if (subject.init) {
    console.log("### Initialization\n");
    console.log("```typescript");
    console.log(subject.init);
    console.log("```\n");
  }

  // Print examples
  for (let i = 0; i < subject.examples.length; i++) {
    const example = subject.examples[i];

    console.log(`### Example ${i + 1}\n`);
    console.log("```typescript");
    console.log(example.code);
    console.log("```");

    if (example.explanation) {
      console.log();
      console.log(example.explanation);
    }

    console.log();
  }
}

/**
 * Print information about the corpus command
 */
function printCorpusHelp(): void {
  console.log("Fragno Corpus - Code examples and documentation");
  console.log("");
  console.log("Usage: fragno-cli corpus [topic...]");
  console.log("");
  console.log("Examples:");
  console.log("  fragno-cli corpus                           # List all available topics");
  console.log("  fragno-cli corpus defining-routes           # Show route definition examples");
  console.log("  fragno-cli corpus database-adapters kysely-adapter");
  console.log("                                              # Show multiple topics");
  console.log("");
  console.log("Available topics:");

  const subjects = getSubjects();
  for (const subject of subjects) {
    console.log(`  ${subject.id.padEnd(30)} ${subject.title}`);
  }
}

export const corpusCommand = define({
  name: "corpus",
  description: "View code examples and documentation for Fragno",
  run: (ctx) => {
    const topics = ctx.positionals;

    // No topics provided - show help
    if (topics.length === 0) {
      printCorpusHelp();
      return;
    }

    // Load and display requested topics
    try {
      const subjects = getSubject(...topics);

      for (const subject of subjects) {
        printSubject(subject);
      }

      console.log(`${"=".repeat(60)}`);
      console.log(`Displayed ${subjects.length} topic(s)`);
      console.log(`${"=".repeat(60)}\n`);
    } catch (error) {
      console.error("Error loading topics:", error instanceof Error ? error.message : error);
      console.log("\nRun 'fragno-cli corpus' to see available topics.");
      process.exit(1);
    }
  },
});
