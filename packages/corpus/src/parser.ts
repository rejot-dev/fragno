import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isCategory } from "./subject-tree.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Basic information about a subject
 */
export interface SubjectInfo {
  id: string;
  title: string;
}

/**
 * A single example within a subject
 */
export interface Example {
  code: string;
  explanation: string;
  testName?: string;
  id?: string;
  typesOnly?: boolean;
}

/**
 * A code block with optional ID
 */
export interface CodeBlock {
  code: string;
  id?: string;
}

/**
 * A markdown section with heading and content
 */
export interface Section {
  heading: string;
  content: string;
  lineNumber?: number;
}

/**
 * Complete subject with all examples and metadata
 */
export interface Subject {
  id: string;
  title: string;
  description: string;
  imports: string;
  prelude: CodeBlock[];
  testInit: CodeBlock[];
  examples: Example[];
  sections: Section[];
}

/**
 * Raw parsed data from markdown before processing
 */
export interface ParsedMarkdown {
  title: string;
  description: string;
  imports: string;
  prelude: CodeBlock[];
  testInit: CodeBlock[];
  testBlocks: Array<{
    code: string;
    explanation: string;
    testName?: string;
    id?: string;
    typesOnly?: boolean;
  }>;
  sections: Section[];
}

// Look for subjects directory in source or relative to built dist
const SUBJECTS_DIR = (() => {
  // Try dist/../src/subjects (when running from built code)
  const distRelative = join(__dirname, "..", "src", "subjects");
  try {
    readdirSync(distRelative);
    return distRelative;
  } catch {
    // Fall back to ./subjects (when running from source)
    return join(__dirname, "subjects");
  }
})();

/**
 * Helper function to extract code blocks with optional IDs from a directive
 */
function extractCodeBlocks(content: string, directive: string): CodeBlock[] {
  const regex = new RegExp(
    `\`\`\`typescript @fragno-${directive}(?::(\\w+(?:-\\w+)*))?\\n([\\s\\S]*?)\`\`\``,
    "g",
  );
  const blocks: CodeBlock[] = [];

  let match;
  while ((match = regex.exec(content)) !== null) {
    const id = match[1] || undefined;
    const code = match[2].trim();
    blocks.push({ code, id });
  }

  return blocks;
}

/**
 * Parses a markdown file and extracts structured content
 */
export function parseMarkdownFile(content: string): ParsedMarkdown {
  // Extract title (first # heading)
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Untitled";

  // Extract imports block
  const importsMatch = content.match(/```typescript @fragno-imports\n([\s\S]*?)```/);
  const imports = importsMatch ? importsMatch[1].trim() : "";

  // Extract prelude blocks
  const prelude = extractCodeBlocks(content, "prelude");

  // Extract test-init blocks
  const testInit = extractCodeBlocks(content, "test-init");

  // Extract all test blocks with their explanations and optional IDs
  // Pattern: ```typescript @fragno-test[:id] [types-only]
  const testBlockRegex =
    /```typescript @fragno-test(?::(\w+(?:-\w+)*))?\s*(types-only)?\n([\s\S]*?)```([\s\S]*?)(?=```typescript @fragno-test|$)/g;
  const testBlocks: Array<{
    code: string;
    explanation: string;
    testName?: string;
    id?: string;
    typesOnly?: boolean;
  }> = [];

  let match;
  while ((match = testBlockRegex.exec(content)) !== null) {
    const id = match[1] || undefined;
    const typesOnly = match[2] === "types-only";
    const code = match[3].trim();

    // Extract test name from first line if it's a comment
    const lines = code.split("\n");
    let testName: string | undefined;
    if (lines[0]?.trim().startsWith("//")) {
      testName = lines[0].replace(/^\/\/\s*/, "").trim();
    }

    // Get explanation text after the code block until next code block or end
    const afterBlock = match[4];
    const explanation = afterBlock
      .split(/```/)[0] // Stop at next code block
      .trim();

    testBlocks.push({ code, explanation, testName, id, typesOnly });
  }

  // Extract description (everything between title and first code block or ## heading)
  const afterTitle = content.substring(content.indexOf(title) + title.length);
  const descriptionMatch = afterTitle.match(/\n\n([\s\S]*?)(?=```|##|$)/);
  const description = descriptionMatch ? descriptionMatch[1].trim() : "";

  // Extract all sections (## headings and their content)
  const sections: Section[] = [];
  const sectionRegex = /^##\s+(.+)$/gm;
  const matches = [...content.matchAll(sectionRegex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const heading = match[1].trim();
    const sectionStart = match.index! + match[0].length;
    const nextSectionStart = matches[i + 1]?.index ?? content.length;
    let sectionContent = content.substring(sectionStart, nextSectionStart).trim();

    // Convert @fragno directive code blocks to regular typescript blocks for display
    sectionContent = sectionContent.replace(
      /```typescript @fragno-\w+(?::\w+(?:-\w+)*)?/g,
      "```typescript",
    );
    sectionContent = sectionContent.trim();

    if (sectionContent) {
      sections.push({ heading, content: sectionContent });
    }
  }

  return {
    title,
    description,
    imports,
    prelude,
    testInit,
    testBlocks,
    sections,
  };
}

/**
 * Converts parsed markdown to a Subject
 */
export function markdownToSubject(id: string, parsed: ParsedMarkdown): Subject {
  const examples: Example[] = parsed.testBlocks.map((block) => ({
    code: block.code,
    explanation: block.explanation,
    testName: block.testName,
    id: block.id,
    typesOnly: block.typesOnly,
  }));

  return {
    id,
    title: parsed.title,
    description: parsed.description,
    imports: parsed.imports,
    prelude: parsed.prelude,
    testInit: parsed.testInit,
    examples,
    sections: parsed.sections,
  };
}

/**
 * Loads and parses a subject file by ID
 * Returns null for category nodes (which have no markdown file)
 */
export function loadSubject(id: string): Subject | null {
  // Categories don't have markdown files
  if (isCategory(id)) {
    return null;
  }

  const filePath = join(SUBJECTS_DIR, `${id}.md`);

  // Check if file exists before trying to read
  if (!existsSync(filePath)) {
    throw new Error(`Subject file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");
  const parsed = parseMarkdownFile(content);
  return markdownToSubject(id, parsed);
}

/**
 * Gets all available subject IDs from the subjects directory
 */
export function getAvailableSubjectIds(): string[] {
  const files = readdirSync(SUBJECTS_DIR);
  return files.filter((file) => file.endsWith(".md")).map((file) => basename(file, ".md"));
}

/**
 * Loads multiple subjects by their IDs
 * Skips category nodes (which have no markdown files)
 */
export function loadSubjects(ids: string[]): Subject[] {
  return ids.map((id) => loadSubject(id)).filter((s): s is Subject => s !== null);
}

/**
 * Loads all available subjects
 */
export function loadAllSubjects(): Subject[] {
  const ids = getAvailableSubjectIds();
  return loadSubjects(ids);
}
