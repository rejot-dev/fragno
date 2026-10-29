import { parseBackofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { absoluteFilePathSchema } from "@fragno-private/backoffice-ui/absolute-file-path";
import type { Element, Root as HastRoot } from "hast";
import type { Link, PhrasingContent, Root as MdastRoot, Text } from "mdast";
import { defaultRehypePlugins, defaultRemarkPlugins, type StreamdownProps } from "streamdown";
import { CONTINUE, SKIP, visit } from "unist-util-visit";

const FILE_ROOT = /^\/(?:workspace|static|system)\//u;
const SCOPED_FILE_DESTINATION = /^\/([^/]+)(\/(?:workspace|static|system)\/.*)$/u;
// The lookbehind keeps URLs (`https://host/workspace/…`) and relative paths (`./workspace/…`) out.
const BARE_FILE_PATH = /(?<![\w/.~-])\/(?:workspace|static|system)\/[^\s`'"<>()[\]{}]+/gu;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;
const LINE_SUFFIX = /:\d+(?::\d+)?$/u;

export const remarkPlugins: StreamdownProps["remarkPlugins"] = [
  ...Object.values(defaultRemarkPlugins),
  remarkFileMentions,
];

// Destinations are resolved after raw HTML is sanitized, so a raw tag cannot pose as a file
// element, and before harden, which normalizes `/workspace/../logout` into `/logout`.
export const rehypePlugins: StreamdownProps["rehypePlugins"] = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  rehypeFileDestinations,
  defaultRehypePlugins.harden,
];

/** Agents mention files in inline code and prose; this links each mention like a Markdown link. */
function remarkFileMentions() {
  return (tree: MdastRoot) => {
    visit(tree, (node, index, parent) => {
      // Links cannot nest; any image inside still resolves in rehypeFileDestinations.
      if (node.type === "link" || node.type === "linkReference") {
        return SKIP;
      }
      if (!parent || index === undefined) {
        return CONTINUE;
      }
      // Text and inline code only sit in phrasing parents.
      const siblings = parent.children as PhrasingContent[];
      if (node.type === "inlineCode") {
        const path = readMention(node.value.trim());
        if (path) {
          siblings[index] = fileLink(path, [node]);
        }
        return SKIP;
      }
      if (node.type === "text") {
        const nodes = linkBareMentions(node);
        siblings.splice(index, 1, ...nodes);
        return [SKIP, index + nodes.length];
      }
      return CONTINUE;
    });
  };
}

/**
 * Turns links and images to file paths into elements that resolve against the viewer's scope, and
 * links to a path after a scope, as in `/org:<orgId>/workspace/report.md`, into ones that resolve
 * against that scope. A file destination that is not a valid path never becomes a URL: its link is
 * plain text and its image shows as unavailable.
 */
function rehypeFileDestinations() {
  return (tree: HastRoot) => {
    visit(tree, "element", (node: Element) => {
      const scoped = node.tagName === "a" ? readScopedDestination(node.properties.href) : null;
      if (scoped) {
        node.tagName = "scoped-file-link";
        node.properties = scoped;
      } else if (node.tagName === "a" && isFileDestination(node.properties.href)) {
        const path = readDestination(node.properties.href);
        node.tagName = path ? "file-link" : "span";
        node.properties = path ? { path } : {};
      } else if (node.tagName === "img" && isFileDestination(node.properties.src)) {
        const path = readDestination(node.properties.src);
        const alt = String(node.properties.alt ?? "");
        node.tagName = path ? "file-image" : "unavailable-image";
        node.properties = path ? { path, alt } : { alt };
      }
    });
  };
}

function linkBareMentions(text: Text): PhrasingContent[] {
  const nodes: PhrasingContent[] = [];
  let consumed = 0;
  for (const match of text.value.matchAll(BARE_FILE_PATH)) {
    const mention = match[0].replace(TRAILING_PUNCTUATION, "");
    const path = readMention(mention);
    if (!path) {
      continue;
    }
    if (match.index > consumed) {
      nodes.push({ type: "text", value: text.value.slice(consumed, match.index) });
    }
    nodes.push(fileLink(path, [{ type: "text", value: mention }]));
    consumed = match.index + mention.length;
  }
  if (consumed === 0) {
    return [text];
  }
  if (consumed < text.value.length) {
    nodes.push({ type: "text", value: text.value.slice(consumed) });
  }
  return nodes;
}

/** A mention may point at a line, as in `/workspace/notes.md:12`; the file is what opens. */
function readMention(mention: string) {
  return readFilePath(mention.replace(LINE_SUFFIX, ""));
}

function isFileDestination(url: unknown): url is string {
  return typeof url === "string" && FILE_ROOT.test(url);
}

/** A link to a file in another scope names the scope as its first segment. */
function readScopedDestination(url: unknown): { scope: string; path: string } | null {
  if (typeof url !== "string") {
    return null;
  }
  const [, encodedScope, destination] = SCOPED_FILE_DESTINATION.exec(url) ?? [];
  if (encodedScope === undefined || destination === undefined) {
    return null;
  }
  let scope: string;
  try {
    scope = decodeURIComponent(encodedScope);
    parseBackofficeScopePathSegment(scope);
  } catch {
    return null;
  }
  const path = readDestination(destination);
  return path === null ? null : { scope, path };
}

/** Markdown destinations are URI-encoded; file paths are literal. */
function readDestination(url: string) {
  try {
    return readFilePath(decodeURIComponent(url));
  } catch {
    return null;
  }
}

function readFilePath(candidate: string) {
  const path = candidate.replace(/\/+$/u, "");
  return FILE_ROOT.test(path) && absoluteFilePathSchema.safeParse(path).success ? path : null;
}

function fileLink(path: string, children: Link["children"]): Link {
  // Encoded per segment so readDestination recovers the literal path, `#` and `%` included.
  return { type: "link", url: path.split("/").map(encodeURIComponent).join("/"), children };
}
