import { define } from "gunshi";
import {
  getSubjects,
  getSubject,
  getAllSubjects,
  getSubjectParent,
  getSubjectChildren,
} from "@fragno-dev/corpus";
import type { Subject, Example } from "@fragno-dev/corpus";
import { marked } from "marked";
// @ts-expect-error - marked-terminal types are outdated for v7
import { markedTerminal } from "marked-terminal";
import { stripVTControlCharacters } from "node:util";

// Always configure marked to use terminal renderer
marked.use(markedTerminal());

interface PrintOptions {
  showLineNumbers: boolean;
  startLine?: number;
  endLine?: number;
  headingsOnly: boolean;
}

/**
 * Build markdown content for multiple subjects
 */
function buildSubjectsMarkdown(subjects: Subject[]): string {
  let fullMarkdown = "";

  for (const subject of subjects) {
    fullMarkdown += `# ${subject.title}\n\n`;

    if (subject.description) {
      fullMarkdown += `${subject.description}\n\n`;
    }

    // Add imports block if present
    if (subject.imports) {
      fullMarkdown += `### Imports\n\n\`\`\`typescript\n${subject.imports}\n\`\`\`\n\n`;
    }

    // Add prelude blocks if present
    if (subject.prelude.length > 0) {
      fullMarkdown += `### Prelude\n\n`;
      for (const block of subject.prelude) {
        // Don't include the directive in the displayed code fence
        fullMarkdown += `\`\`\`typescript\n${block.code}\n\`\`\`\n\n`;
      }
    }

    // Add all sections
    for (const section of subject.sections) {
      fullMarkdown += `## ${section.heading}\n\n${section.content}\n\n`;
    }
  }

  return fullMarkdown;
}

/**
 * Add line numbers to content
 */
function addLineNumbers(content: string, startFrom: number = 1): string {
  const lines = content.split("\n");
  const maxDigits = String(startFrom + lines.length - 1).length;

  return lines
    .map((line, index) => {
      const lineNum = startFrom + index;
      const paddedNum = String(lineNum).padStart(maxDigits, " ");
      return `${paddedNum}│ ${line}`;
    })
    .join("\n");
}

/**
 * Filter content by line range
 */
function filterByLineRange(content: string, startLine: number, endLine: number): string {
  const lines = content.split("\n");
  // Convert to 0-based index
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  return lines.slice(start, end).join("\n");
}

/**
 * Extract headings and code block information with line numbers
 */
function extractHeadingsAndBlocks(subjects: Subject[]): string {
  let output = "";
  let currentLine = 1;
  let lastOutputLine = 0;

  // Helper to add a gap indicator if we skipped lines
  const addGapIfNeeded = () => {
    if (lastOutputLine > 0 && currentLine > lastOutputLine + 1) {
      output += `    │\n`;
    }
  };

  // Add instruction header
  output += "Use --start N --end N flags to show specific line ranges\n\n";

  for (const subject of subjects) {
    // Title
    addGapIfNeeded();
    output += `${currentLine.toString().padStart(4, " ")}│ # ${subject.title}\n`;
    lastOutputLine = currentLine;
    currentLine += 1;

    // Empty line after title - SHOW IT
    output += `${currentLine.toString().padStart(4, " ")}│\n`;
    lastOutputLine = currentLine;
    currentLine += 1;

    // Description - show full text
    if (subject.description) {
      const descLines = subject.description.split("\n");
      for (const line of descLines) {
        output += `${currentLine.toString().padStart(4, " ")}│ ${line}\n`;
        lastOutputLine = currentLine;
        currentLine += 1;
      }
      // Empty line after description - SHOW IT
      output += `${currentLine.toString().padStart(4, " ")}│\n`;
      lastOutputLine = currentLine;
      currentLine += 1;
    }

    // Imports block - show full code
    if (subject.imports) {
      addGapIfNeeded();
      output += `${currentLine.toString().padStart(4, " ")}│ ### Imports\n`;
      lastOutputLine = currentLine;
      currentLine += 1;
      // Empty line after heading - SHOW IT
      output += `${currentLine.toString().padStart(4, " ")}│\n`;
      lastOutputLine = currentLine;
      currentLine += 1;
      output += `${currentLine.toString().padStart(4, " ")}│ \`\`\`typescript\n`;
      lastOutputLine = currentLine;
      currentLine += 1;
      const importLines = subject.imports.split("\n");
      for (const line of importLines) {
        output += `${currentLine.toString().padStart(4, " ")}│ ${line}\n`;
        lastOutputLine = currentLine;
        currentLine += 1;
      }
      output += `${currentLine.toString().padStart(4, " ")}│ \`\`\`\n`;
      lastOutputLine = currentLine;
      currentLine += 1;
      // Empty line after code block - SHOW IT
      output += `${currentLine.toString().padStart(4, " ")}│\n`;
      lastOutputLine = currentLine;
      currentLine += 1;
    }

    // Prelude blocks - show as list
    if (subject.prelude.length > 0) {
      addGapIfNeeded();
      output += `${currentLine.toString().padStart(4, " ")}│ ### Prelude\n`;
      lastOutputLine = currentLine;
      currentLine += 1;
      // Empty line after heading
      output += `${currentLine.toString().padStart(4, " ")}│\n`;
      lastOutputLine = currentLine;
      currentLine += 1;

      for (const block of subject.prelude) {
        const id = block.id || "(no-id)";
        const blockStartLine = currentLine + 1; // +1 for opening ```
        const codeLines = block.code.split("\n").length;
        const blockEndLine = currentLine + 1 + codeLines; // opening ``` + code lines
        output += `${currentLine.toString().padStart(4, " ")}│   - id: \`${id}\`, L${blockStartLine}-${blockEndLine}\n`;
        lastOutputLine = currentLine;
        currentLine += codeLines + 3; // opening ```, code, closing ```, blank line
      }
      // Update lastOutputLine to current position to avoid gap indicator
      lastOutputLine = currentLine - 1;
    }

    // Sections - show headings and any example IDs that belong to them
    const sectionToExamples = new Map<string, Example[]>();

    // Group examples by their rough section (based on heading appearance in explanations)
    for (const example of subject.examples) {
      // Try to match the example to a section based on context
      // For now, we'll list all example IDs under the sections where they appear
      for (const section of subject.sections) {
        // Check if the section contains references to this example
        if (
          section.content.includes(example.code.substring(0, Math.min(50, example.code.length)))
        ) {
          if (!sectionToExamples.has(section.heading)) {
            sectionToExamples.set(section.heading, []);
          }
          sectionToExamples.get(section.heading)!.push(example);
          break;
        }
      }
    }

    for (const section of subject.sections) {
      addGapIfNeeded();
      output += `${currentLine.toString().padStart(4, " ")}│ ## ${section.heading}\n`;
      lastOutputLine = currentLine;
      currentLine += 1;

      // Show code block IDs as a list if any examples match this section
      const examples = sectionToExamples.get(section.heading) || [];
      if (examples.length > 0) {
        // We need to parse the section content to find where each example appears
        const sectionStartLine = currentLine;
        const lines = section.content.split("\n");

        for (const example of examples) {
          const id = example.id || "(no-id)";
          // Find the code block in section content
          let blockStartLine = sectionStartLine;
          let blockEndLine = sectionStartLine;
          let inCodeBlock = false;
          let foundBlock = false;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim().startsWith("```") && !inCodeBlock) {
              // Check if next lines match the example
              const codeStart = i + 1;
              let matches = true;
              const exampleLines = example.code.split("\n");
              for (let j = 0; j < Math.min(3, exampleLines.length); j++) {
                if (lines[codeStart + j]?.trim() !== exampleLines[j]?.trim()) {
                  matches = false;
                  break;
                }
              }
              if (matches) {
                blockStartLine = sectionStartLine + i + 1; // +1 to skip opening ```
                blockEndLine = sectionStartLine + i + exampleLines.length;
                foundBlock = true;
                break;
              }
            }
          }

          if (foundBlock) {
            output += `${currentLine.toString().padStart(4, " ")}│   - id: \`${id}\`, L${blockStartLine}-${blockEndLine}\n`;
          } else {
            output += `${currentLine.toString().padStart(4, " ")}│   - id: \`${id}\`\n`;
          }
          lastOutputLine = currentLine;
        }
      }

      // Count lines
      const sectionLines = section.content.split("\n");
      for (const _line of sectionLines) {
        currentLine += 1;
      }
      currentLine += 1; // blank line after section
      // Update lastOutputLine to current position to avoid gap indicator
      lastOutputLine = currentLine - 1;
    }
  }

  return output;
}

/**
 * Print subjects with the given options
 */
async function printSubjects(subjects: Subject[], options: PrintOptions): Promise<void> {
  if (options.headingsOnly) {
    // Show only headings and code block IDs
    const headingsOutput = extractHeadingsAndBlocks(subjects);
    console.log(headingsOutput);
    return;
  }

  // Build the full markdown content
  const markdown = buildSubjectsMarkdown(subjects);

  // Render markdown to terminal for nice formatting
  let output = await marked.parse(markdown);

  // Apply line range filter if specified (after rendering)
  const startLine = options.startLine ?? 1;
  if (options.startLine !== undefined || options.endLine !== undefined) {
    const end = options.endLine ?? output.split("\n").length;
    output = filterByLineRange(output, startLine, end);
  }

  // Add line numbers after rendering (if requested)
  // Line numbers correspond to the rendered output that agents interact with
  if (options.showLineNumbers) {
    output = addLineNumbers(output, startLine);
  }

  console.log(output);
}

/**
 * Find and print code blocks by ID
 */
async function printCodeBlockById(
  id: string,
  topics: string[],
  showLineNumbers: boolean,
): Promise<void> {
  // If topics are specified, search only those; otherwise search all subjects
  const subjects = topics.length > 0 ? getSubject(...topics) : getAllSubjects();

  interface CodeBlockMatch {
    subjectId: string;
    subjectTitle: string;
    section: string;
    code: string;
    type: "prelude" | "example";
    startLine?: number;
    endLine?: number;
  }

  const matches: CodeBlockMatch[] = [];

  for (const subject of subjects) {
    // Build the rendered markdown to get correct line numbers (matching --start/--end behavior)
    const fullMarkdown = buildSubjectsMarkdown([subject]);
    const renderedOutput = await marked.parse(fullMarkdown);
    const renderedLines = renderedOutput.split("\n");

    // Search in prelude blocks
    for (const block of subject.prelude) {
      if (block.id === id) {
        // Find line numbers in the rendered output
        let startLine: number | undefined;
        let endLine: number | undefined;

        // Search for the prelude code in the rendered output
        const codeLines = block.code.split("\n");
        const firstCodeLine = codeLines[0].trim();

        for (let i = 0; i < renderedLines.length; i++) {
          // Strip ANSI codes before comparing
          if (stripVTControlCharacters(renderedLines[i]).trim() === firstCodeLine) {
            // Found the start of the code
            startLine = i + 1; // 1-based line numbers
            endLine = i + codeLines.length;
            break;
          }
        }

        matches.push({
          subjectId: subject.id,
          subjectTitle: subject.title,
          section: "Prelude",
          code: block.code,
          type: "prelude",
          startLine,
          endLine,
        });
      }
    }

    // Search in examples
    for (const example of subject.examples) {
      if (example.id === id) {
        // Try to find which section this example belongs to
        let sectionName = "Unknown Section";
        let startLine: number | undefined;
        let endLine: number | undefined;

        for (const section of subject.sections) {
          if (
            section.content.includes(example.code.substring(0, Math.min(50, example.code.length)))
          ) {
            sectionName = section.heading;

            // Find line numbers in the rendered output
            const codeLines = example.code.split("\n");
            const firstCodeLine = codeLines[0].trim();

            for (let i = 0; i < renderedLines.length; i++) {
              // Strip ANSI codes before comparing
              if (stripVTControlCharacters(renderedLines[i]).trim() === firstCodeLine) {
                // Found the start of the code
                startLine = i + 1; // 1-based line numbers
                endLine = i + codeLines.length;
                break;
              }
            }
            break;
          }
        }

        matches.push({
          subjectId: subject.id,
          subjectTitle: subject.title,
          section: sectionName,
          code: example.code,
          type: "example",
          startLine,
          endLine,
        });
      }
    }
  }

  if (matches.length === 0) {
    console.error(`Error: No code block found with id "${id}"`);
    if (topics.length > 0) {
      console.error(`Searched in topics: ${topics.join(", ")}`);
    } else {
      console.error("Searched in all available topics");
    }
    process.exit(1);
  }

  // Build markdown output
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];

    if (matches.length > 1 && i > 0) {
      console.log("\n---\n");
    }

    // Build markdown for this match
    let matchMarkdown = `# ${match.subjectTitle}\n\n`;
    matchMarkdown += `## ${match.section}\n\n`;

    // Add line number info if available and requested (as plain text, not in markdown)
    if (showLineNumbers && match.startLine && match.endLine) {
      console.log(`Lines ${match.startLine}-${match.endLine} (use with --start/--end)\n`);
    }

    matchMarkdown += `\`\`\`typescript\n${match.code}\n\`\`\`\n`;

    // Render the markdown
    const rendered = await marked.parse(matchMarkdown);
    console.log(rendered);
  }
}

/**
 * Print only the topic tree
 */
function printTopicTree(): void {
  const subjects = getSubjects();
  const subjectMap = new Map(subjects.map((s) => [s.id, s]));

  // Helper function to recursively display tree
  function displayNode(subjectId: string, indent: string, isLast: boolean, isRoot: boolean): void {
    const subject = subjectMap.get(subjectId);
    if (!subject) {
      return;
    }

    if (isRoot) {
      console.log(`  ${subject.id.padEnd(30)} ${subject.title}`);
    } else {
      const connector = isLast ? "└─" : "├─";
      console.log(`${indent}${connector} ${subject.id.padEnd(26)} ${subject.title}`);
    }

    const children = getSubjectChildren(subjectId);
    if (children.length > 0) {
      const childIndent = isRoot ? "    " : indent + (isLast ? "   " : "│  ");
      for (let i = 0; i < children.length; i++) {
        displayNode(children[i], childIndent, i === children.length - 1, false);
      }
    }
  }

  // Display root subjects
  for (const subject of subjects) {
    const parent = getSubjectParent(subject.id);
    if (!parent) {
      displayNode(subject.id, "", false, true);
    }
  }
}

/**
 * Print information about the corpus command
 */
function printCorpusHelp(): void {
  console.log("Fragno Corpus - Code examples and documentation (similar to LLMs.txt");
  console.log("");
  console.log("Usage: fragno-cli corpus [options] [topic...]");
  console.log("");
  console.log("Options:");
  console.log("  -n, --no-line-numbers      Hide line numbers (shown by default)");
  console.log("  -s, --start N              Starting line number to display from");
  console.log("  -e, --end N                Ending line number to display to");
  console.log("  --headings                 Show only headings and code block IDs");
  console.log("  --id <id>                  Retrieve a specific code block by ID");
  console.log("  --tree                     Show only the topic tree");
  console.log("");
  console.log("Examples:");
  console.log("  fragno-cli corpus                           # List all available topics");
  console.log("  fragno-cli corpus --tree                    # Show only the topic tree");
  console.log("  fragno-cli corpus defining-routes           # Show route definition examples");
  console.log("  fragno-cli corpus --headings database-querying");
  console.log("                                              # Show structure overview");
  console.log("  fragno-cli corpus --start 10 --end 50 database-querying");
  console.log("                                              # Show specific lines");
  console.log("  fragno-cli corpus --id create-user          # Get code block by ID");
  console.log("  fragno-cli corpus database-adapters kysely-adapter");
  console.log("                                              # Show multiple topics");
  console.log("");
  console.log("Available topics:");

  printTopicTree();
}

export const corpusCommand = define({
  name: "corpus",
  description: "View code examples and documentation for Fragno",
  args: {
    "no-line-numbers": {
      type: "boolean",
      short: "n",
      description: "Hide line numbers (line numbers are shown by default)",
    },
    start: {
      type: "number",
      short: "s",
      description: "Starting line number (1-based) to display from",
    },
    end: {
      type: "number",
      short: "e",
      description: "Ending line number (1-based) to display to",
    },
    headings: {
      type: "boolean",
      description: "Show only section headings and code block IDs with line numbers",
    },
    id: {
      type: "string",
      description: "Retrieve a specific code block by ID",
    },
    tree: {
      type: "boolean",
      description: "Show only the topic tree (without help text)",
    },
  },
  run: async (ctx) => {
    const topics = ctx.positionals;
    const showLineNumbers = !(ctx.values["no-line-numbers"] ?? false);
    const startLine = ctx.values.start;
    const endLine = ctx.values.end;
    const headingsOnly = ctx.values.headings ?? false;
    const codeBlockId = ctx.values.id;
    const treeOnly = ctx.values.tree ?? false;

    // Handle --id flag
    if (codeBlockId) {
      await printCodeBlockById(codeBlockId, topics, showLineNumbers);
      return;
    }

    // Handle --tree flag
    if (treeOnly) {
      printTopicTree();
      return;
    }

    // No topics provided - show help
    if (topics.length === 0) {
      printCorpusHelp();
      return;
    }

    // Validate line range
    if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
      console.error("Error: --start must be less than or equal to --end");
      process.exit(1);
    }

    // Load and display requested topics
    try {
      const subjects = getSubject(...topics);

      await printSubjects(subjects, {
        showLineNumbers,
        startLine,
        endLine,
        headingsOnly,
      });
    } catch (error) {
      console.error("Error loading topics:", error instanceof Error ? error.message : error);
      console.log("\nRun 'fragno-cli corpus' to see available topics.");
      process.exit(1);
    }
  },
});
