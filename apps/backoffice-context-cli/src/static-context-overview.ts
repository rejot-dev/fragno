import { readdir, readFile } from "node:fs/promises";
import { basename, posix, relative, resolve } from "node:path";

import { parse } from "yaml";

const SYSTEM_PATH = "/static/SYSTEM.md";
const CODEMODE_SYSTEM_PATH = "/static/codemode/system.d.ts";
const CODEMODE_PLACEHOLDER = "__BACKOFFICE_CODEMODE_DTS__";

type StaticFileReference = {
  kind: "file" | "system-expansion";
  targetPath: string;
  line: number;
};

type StaticFileNode = {
  path: string;
  summary: string;
  references: StaticFileReference[];
};

type StaticSkillEntry = {
  name: string;
  description: string;
  path: string;
};

type StaticContextAnalysis = {
  nodes: Map<string, StaticFileNode>;
  skills: StaticSkillEntry[];
  unreferencedPaths: string[];
};

type SkillFrontmatter = {
  name: string;
  description: string;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (content.charCodeAt(position) === 10) {
      line += 1;
    }
  }
  return line;
}

function isFileReference(path: string): boolean {
  const fileName = posix.basename(path);
  return fileName.includes(".") && !path.includes("*");
}

function normalizeStaticPath(path: string): string {
  return posix.normalize(path.startsWith("/static/") ? path : `/static/${path}`);
}

function extractStaticFileReferences(sourcePath: string, content: string): StaticFileReference[] {
  const references: StaticFileReference[] = [];
  const absolutePathPattern = /\/static\/[A-Za-z0-9_./?*-]+/g;

  for (const match of content.matchAll(absolutePathPattern)) {
    const targetPath = normalizeStaticPath(match[0].replace(/[.,;:]+$/, ""));
    if (!isFileReference(targetPath)) {
      continue;
    }
    references.push({
      kind: "file",
      targetPath,
      line: lineNumberAt(content, match.index),
    });
  }

  if (sourcePath.endsWith(".md")) {
    const markdownLinkPattern = /\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g;
    for (const match of content.matchAll(markdownLinkPattern)) {
      const linkTarget = match[1];
      if (
        linkTarget.startsWith("/") ||
        linkTarget.includes("://") ||
        !isFileReference(linkTarget)
      ) {
        continue;
      }
      references.push({
        kind: "file",
        targetPath: normalizeStaticPath(posix.join(posix.dirname(sourcePath), linkTarget)),
        line: lineNumberAt(content, match.index),
      });
    }
  }

  if (sourcePath === SYSTEM_PATH) {
    const placeholderIndex = content.indexOf(CODEMODE_PLACEHOLDER);
    if (placeholderIndex !== -1) {
      references.push({
        kind: "system-expansion",
        targetPath: CODEMODE_SYSTEM_PATH,
        line: lineNumberAt(content, placeholderIndex),
      });
    }
  }

  const seen = new Set<string>();
  return references
    .filter((reference) => {
      const key = `${reference.kind}:${reference.targetPath}:${reference.line}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) => left.line - right.line || left.targetPath.localeCompare(right.targetPath),
    );
}

function parseSkillFrontmatter(path: string, content: string): SkillFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error(`Backoffice context skill frontmatter missing: ${path}`);
  }

  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) {
    throw new Error(`Backoffice context skill frontmatter is not closed: ${path}`);
  }

  const parsed: unknown = parse(normalized.slice(4, endIndex));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Backoffice context skill frontmatter must be a mapping: ${path}`);
  }

  const frontmatter = parsed as Record<string, unknown>;
  if (typeof frontmatter["name"] !== "string" || typeof frontmatter["description"] !== "string") {
    throw new Error(`Backoffice context skill needs string name and description fields: ${path}`);
  }

  return {
    name: frontmatter["name"],
    description: normalizeWhitespace(frontmatter["description"]),
  };
}

function summarizeMarkdown(path: string, content: string): string {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1];
  return heading ? normalizeWhitespace(heading) : `${basename(path)} Markdown`;
}

function summarizeDeclarationFile(path: string, content: string): string {
  for (const line of content.split("\n")) {
    if (line.startsWith("///")) {
      continue;
    }
    const comment = /^\/\/\s*(.+)$/.exec(line)?.[1];
    if (!comment) {
      continue;
    }
    const summary = normalizeWhitespace(comment.replace(/[─━]+/g, " "));
    if (summary) {
      return summary;
    }
  }
  return `${basename(path)} TypeScript declarations`;
}

function summarizeStaticFile(path: string, content: string): string {
  if (path.endsWith(".md")) {
    return summarizeMarkdown(path, content);
  }
  if (path.endsWith(".d.ts")) {
    return summarizeDeclarationFile(path, content);
  }
  if (path.endsWith(".workflow.js")) {
    return `${basename(path)} saved automation`;
  }
  if (path.endsWith(".json")) {
    return `${basename(path)} JSON data`;
  }
  return basename(path);
}

async function listStaticFilePaths(staticDirectory: string): Promise<string[]> {
  const paths: string[] = [];

  async function visitDirectory(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visitDirectory(path);
      } else if (entry.isFile()) {
        paths.push(path);
      }
    }
  }

  await visitDirectory(staticDirectory);
  return paths;
}

function collectReachablePaths(
  entryPaths: string[],
  nodes: Map<string, StaticFileNode>,
): Set<string> {
  const reachablePaths = new Set<string>();
  const pendingPaths = [...entryPaths];

  while (pendingPaths.length > 0) {
    const path = pendingPaths.pop();
    if (!path || reachablePaths.has(path)) {
      continue;
    }
    reachablePaths.add(path);
    const node = nodes.get(path);
    if (!node) {
      continue;
    }
    for (const reference of node.references) {
      pendingPaths.push(reference.targetPath);
    }
  }

  return reachablePaths;
}

async function analyzeStaticContext(staticDirectory: string): Promise<StaticContextAnalysis> {
  const absoluteStaticDirectory = resolve(staticDirectory);
  const filePaths = await listStaticFilePaths(absoluteStaticDirectory);
  const nodes = new Map<string, StaticFileNode>();
  const skills: StaticSkillEntry[] = [];

  for (const filePath of filePaths) {
    const content = await readFile(filePath, "utf8");
    const relativePath = relative(absoluteStaticDirectory, filePath).split("\\").join("/");
    const path = normalizeStaticPath(relativePath);
    nodes.set(path, {
      path,
      summary: summarizeStaticFile(path, content),
      references: extractStaticFileReferences(path, content),
    });

    if (path.endsWith("/SKILL.md")) {
      const frontmatter = parseSkillFrontmatter(path, content);
      skills.push({ ...frontmatter, path });
    }
  }

  if (!nodes.has(SYSTEM_PATH)) {
    throw new Error(`Backoffice context SYSTEM.md missing from ${absoluteStaticDirectory}`);
  }

  skills.sort((left, right) => left.name.localeCompare(right.name));
  const duplicateSkillNames = skills.filter(
    (skill, index) => index > 0 && skill.name === skills[index - 1]?.name,
  );
  if (duplicateSkillNames.length > 0) {
    throw new Error(`Backoffice context duplicate skill name: ${duplicateSkillNames[0]?.name}`);
  }

  const entryPaths = [SYSTEM_PATH, ...skills.map((skill) => skill.path)];
  const reachablePaths = collectReachablePaths(entryPaths, nodes);
  const unreferencedPaths = [...nodes.keys()]
    .filter((path) => !reachablePaths.has(path))
    .sort((left, right) => left.localeCompare(right));

  return {
    nodes,
    skills,
    unreferencedPaths,
  };
}

function renderReferenceGraph(rootPath: string, nodes: Map<string, StaticFileNode>): string[] {
  const rootNode = nodes.get(rootPath);
  if (!rootNode) {
    return [`${rootPath} [missing]`];
  }

  const lines = [`${rootNode.path} — ${rootNode.summary}`];
  const expandedPaths = new Set([rootPath]);

  function renderChildren(path: string, prefix: string, ancestors: Set<string>): void {
    const node = nodes.get(path);
    if (!node) {
      return;
    }

    node.references.forEach((reference, index) => {
      const isLast = index === node.references.length - 1;
      const branch = isLast ? "└─ " : "├─ ";
      const childPrefix = `${prefix}${isLast ? "   " : "│  "}`;
      const targetNode = nodes.get(reference.targetPath);
      const source =
        reference.kind === "system-expansion"
          ? `${CODEMODE_PLACEHOLDER} expands from ${reference.targetPath}`
          : reference.targetPath;
      const summary = targetNode ? ` — ${targetNode.summary}` : " [missing]";
      const location =
        reference.kind === "system-expansion"
          ? ` [expanded at line ${reference.line}]`
          : ` [line ${reference.line}]`;
      const isCycle = ancestors.has(reference.targetPath);
      const wasExpanded = expandedPaths.has(reference.targetPath);
      const traversalStatus = isCycle ? " [cycle]" : wasExpanded ? " [already expanded]" : "";
      lines.push(`${prefix}${branch}${source}${summary}${location}${traversalStatus}`);

      if (!targetNode || isCycle || wasExpanded) {
        return;
      }

      expandedPaths.add(reference.targetPath);
      renderChildren(
        reference.targetPath,
        childPrefix,
        new Set([...ancestors, reference.targetPath]),
      );
    });
  }

  renderChildren(rootPath, "", new Set([rootPath]));
  return lines;
}

function renderMarkdownCallTree(lines: string[]): string[] {
  return ["```text", ...lines, "```"];
}

function renderStaticContextMarkdown(analysis: StaticContextAnalysis): string {
  const lines = [
    "# Backoffice static agent-context graph",
    "",
    "- **Static mount:** `/static/`",
    `- **Files:** ${analysis.nodes.size}`,
    `- **Entry points:** 1 \`SYSTEM.md\` + ${analysis.skills.length} skills`,
    "",
    "## How context is loaded",
    "",
    "- `SYSTEM.md` is injected automatically.",
    "- Each `SKILL.md` is a top-level candidate; its description tells the agent when to load it.",
    "- Nested paths are follow-up reads mentioned by an already loaded file.",
    `- \`${CODEMODE_PLACEHOLDER}\` is expanded from \`${CODEMODE_SYSTEM_PATH}\`; it is not left opaque.`,
    "",
    "## System entry point",
    "",
    ...renderMarkdownCallTree(renderReferenceGraph(SYSTEM_PATH, analysis.nodes)),
    "",
    "## Skill entry points",
  ];

  for (const skill of analysis.skills) {
    lines.push(
      "",
      `### \`${skill.name}\``,
      "",
      `> **Load when:** ${skill.description}`,
      "",
      ...renderMarkdownCallTree(renderReferenceGraph(skill.path, analysis.nodes)),
    );
  }

  lines.push("", "## Not reachable from `SYSTEM.md` or any `SKILL.md`", "");
  if (analysis.unreferencedPaths.length === 0) {
    lines.push("_None._");
  } else {
    lines.push(...analysis.unreferencedPaths.map((path) => `- \`${path}\``));
  }

  return `${lines.join("\n")}\n`;
}

/** Builds the Markdown call graph for Backoffice files that can add agent context. */
export async function createStaticContextOverviewMarkdown(
  staticDirectory: string,
): Promise<string> {
  return renderStaticContextMarkdown(await analyzeStaticContext(staticDirectory));
}
