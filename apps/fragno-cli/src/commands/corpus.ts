import { define } from "gunshi";
import { getSubjects, getSubject } from "@fragno-dev/corpus";
import { marked } from "marked";
// @ts-expect-error - marked-terminal types are outdated for v7
import { markedTerminal } from "marked-terminal";

// Always configure marked to use terminal renderer
marked.use(markedTerminal());

/**
 * Print a subject with its examples
 */
function printSubject(subject: ReturnType<typeof getSubject>[number]): void {
  // Build full markdown
  let fullMarkdown = `# ${subject.title}\n\n`;

  if (subject.description) {
    fullMarkdown += `${subject.description}\n\n`;
  }

  // Add imports block if present
  if (subject.imports) {
    fullMarkdown += `### Imports\n\n\`\`\`typescript\n${subject.imports}\n\`\`\`\n\n`;
  }

  // Add init block if present
  if (subject.init) {
    fullMarkdown += `### Initialization\n\n\`\`\`typescript\n${subject.init}\n\`\`\`\n\n`;
  }

  // Add all sections
  for (const section of subject.sections) {
    fullMarkdown += `## ${section.heading}\n\n${section.content}\n\n`;
  }

  // Render and print the full markdown
  console.log(marked.parse(fullMarkdown));
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
    } catch (error) {
      console.error("Error loading topics:", error instanceof Error ? error.message : error);
      console.log("\nRun 'fragno-cli corpus' to see available topics.");
      process.exit(1);
    }
  },
});
