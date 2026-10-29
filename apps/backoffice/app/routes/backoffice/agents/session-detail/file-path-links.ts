import { parseBackofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { absoluteFilePathSchema } from "@fragno-private/backoffice-ui/absolute-file-path";
import type { Element, Root as HastRoot } from "hast";
import type { Link, PhrasingContent, Root as MdastRoot, Text } from "mdast";
import { defaultRehypePlugins, defaultRemarkPlugins, type StreamdownProps } from "streamdown";
import { CONTINUE, SKIP, visit } from "unist-util-visit";

const FILE_ROOT = /^\/(?:workspace|static|system)\//u;
const SCOPED_FILE_DESTINATION = /^\/([^/]+)(\/(?:workspace|static|system)\/.*)$/u;
// The lookbehind keeps URLs (`https://host/workspace/…`) and relative paths (`./workspace/…`) out.
// A mention may name another scope first, as links do; `system` is left out as it is a file root.
const BARE_FILE_PATH =
  /(?<![\w/.~-])(?:\/(?:org|user|project|app):[^\s/`'"<>()[\]{}]+)?\/(?:workspace|static|system)\/[^\s`'"<>()[\]{}]+/gu;
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
        const file = readMention(node.value.trim());
        if (file) {
          siblings[index] = fileLink(file, [node]);
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
 * ones to a path after a scope, as in `/org:<orgId>/workspace/report.md`, into elements that
 * resolve against that scope. A file destination that is not a valid path never becomes a URL: its
 * link is plain text and its image shows as unavailable.
 */
function rehypeFileDestinations() {
  return (tree: HastRoot) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName === "a") {
        const destination = readFileDestination(node.properties.href);
        if (destination) {
          node.tagName =
            destination.path === null
              ? "span"
              : destination.scope === null
                ? "file-link"
                : "scoped-file-link";
          node.properties = fileProperties(destination);
        }
      } else if (node.tagName === "img") {
        const destination = readFileDestination(node.properties.src);
        if (destination) {
          node.tagName =
            destination.path === null
              ? "unavailable-image"
              : destination.scope === null
                ? "file-image"
                : "scoped-file-image";
          node.properties = {
            ...fileProperties(destination),
            alt: String(node.properties.alt ?? ""),
          };
        }
      }
    });
  };
}

function linkBareMentions(text: Text): PhrasingContent[] {
  const nodes: PhrasingContent[] = [];
  let consumed = 0;
  for (const match of text.value.matchAll(BARE_FILE_PATH)) {
    const mention = match[0].replace(TRAILING_PUNCTUATION, "");
    const file = readMention(mention);
    if (!file) {
      continue;
    }
    if (match.index > consumed) {
      nodes.push({ type: "text", value: text.value.slice(consumed, match.index) });
    }
    nodes.push(fileLink(file, [{ type: "text", value: mention }]));
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

/** A file a destination or mention names, in another scope when `scope` is not null. */
type FileDestination = { scope: string | null; path: string | null };

/** A mention may point at a line, as in `/workspace/notes.md:12`; the file is what opens. */
function readMention(mention: string): { scope: string | null; path: string } | null {
  const candidate = mention.replace(LINE_SUFFIX, "");
  if (FILE_ROOT.test(candidate)) {
    const path = readFilePath(candidate);
    return path === null ? null : { scope: null, path };
  }
  const [, scope, rest] = SCOPED_FILE_DESTINATION.exec(candidate) ?? [];
  if (scope === undefined || rest === undefined || !isScopeSegment(scope)) {
    return null;
  }
  const path = readFilePath(rest);
  return path === null ? null : { scope, path };
}

/**
 * Reads a destination to a file path, or to one after the scope it is in; null when the URL names
 * no file. A path under a file root is always the viewer's, so `/system/workspace/…` stays a path.
 */
function readFileDestination(url: unknown): FileDestination | null {
  if (typeof url !== "string") {
    return null;
  }
  if (FILE_ROOT.test(url)) {
    return { scope: null, path: readDestination(url) };
  }
  const [, encodedScope, destination] = SCOPED_FILE_DESTINATION.exec(url) ?? [];
  if (encodedScope === undefined || destination === undefined) {
    return null;
  }
  let scope: string;
  try {
    scope = decodeURIComponent(encodedScope);
  } catch {
    return null;
  }
  return isScopeSegment(scope) ? { scope, path: readDestination(destination) } : null;
}

function isScopeSegment(segment: string) {
  try {
    parseBackofficeScopePathSegment(segment);
    return true;
  } catch {
    return false;
  }
}

function fileProperties({ scope, path }: FileDestination) {
  return path === null ? {} : scope === null ? { path } : { scope, path };
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

function fileLink(
  { scope, path }: { scope: string | null; path: string },
  children: Link["children"],
): Link {
  // Encoded per segment so readFileDestination recovers the literal scope and path, `#` and `%`
  // included.
  const url = path.split("/").map(encodeURIComponent).join("/");
  return {
    type: "link",
    url: scope === null ? url : `/${encodeURIComponent(scope)}${url}`,
    children,
  };
}
