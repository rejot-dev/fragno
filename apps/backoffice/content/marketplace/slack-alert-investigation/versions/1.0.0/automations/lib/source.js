/// <reference path="/static/codemode/workflow-authoring.d.ts" />

import { quote, run } from "./sandbox.js";

/** @typedef {{ repository: string, repoPath: string, commit: string }} PreparedRepository */
/** @typedef {{ path: string, score: number, matchedBy: string, lines: number[] }} SourceCandidate */

const SOURCE_GLOBS = [
  "'*.ts'",
  "'*.tsx'",
  "'*.js'",
  "'*.mjs'",
  "':!*node_modules*'",
  "':!*.test.*'",
  "':!*.spec.*'",
  "':!*/fixtures/*'",
].join(" ");

// Words that alert templates use for every alert, so they say nothing about where the failure is.
const STOP_WORDS = new Set(
  (
    "error request response reported incident worker workers issue issues http https first seen " +
    "urgency high file files fetch object triggered with from this that occurrences minutes " +
    "cloudflare pager duty posthog spiking window baseline relay real-time detected type exception " +
    "status active observed last view dashboard dash services production ai-assisted investigation " +
    "server inspect list retained client accounts observability query related logs traces through post"
  ).split(" "),
);

/** Slack escapes &, < and > in message text. @param {string} text */
function decodeSlack(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Error texts and stack-frame names an alert quotes, most specific first. @param {string} alert */
function alertSearchTerms(alert) {
  const text = decodeSlack(alert);
  /** @type {string[]} */
  const titles = [];
  // Cloudflare: "Real-Time Issue '<message> · at <frame> (<file>)' detected in <service>".
  for (const match of text.matchAll(/Real-Time Issue '(.+?)' detected in/g)) {
    titles.push(match[1]);
  }
  // Cloudflare Worker issue summaries: "New issue in <service>: <message> (<frame>, <route>...)".
  for (const match of text.matchAll(/New issue in [\w-]+: (.+?)(?: \(|$| \|)/g)) {
    titles.push(match[1]);
  }
  // PostHog: "PostHog error spiking: <issue name>: <message> (<n> in the last window, ...)".
  for (const match of text.matchAll(
    /PostHog error spiking: (.+?): (.+?) \(\d+ in the last window/g,
  )) {
    titles.push(match[1] + " · " + match[2]);
  }

  const messages = new Set();
  const frames = new Set();
  for (const title of titles) {
    // Titles join an optional error class, the message and stack frames with " · ".
    for (const segment of title.split(" · ")) {
      if (segment.startsWith("at ")) {
        for (const frame of segment.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*) \(/g)) {
          frames.add(frame[1]);
        }
        continue;
      }
      if (/^[A-Z]\w*Error$/.test(segment)) {
        if (segment !== "Error") {
          frames.add(segment);
        }
        continue;
      }
      // Cloudflare replaces variable parts with placeholders such as <path>; search the literal pieces.
      const message = segment.replace(
        /^(?:Request Errored |Uncaught )?(?:[A-Z]\w*Error|Error): /,
        "",
      );
      for (const piece of message.split(/<[a-z]+>|"/)) {
        const literal = piece.trim().replace(/[.:]$/, "");
        if (literal.length >= 12) {
          messages.add(literal);
        }
      }
    }
  }
  for (const match of text.matchAll(/\(([A-Z]\w+\.\w+),/g)) {
    frames.add(match[1]);
  }

  // Frame segments name the function or class; only distinctive ones are worth a definition search.
  const identifiers = [...frames]
    .flatMap((frame) => frame.split("."))
    .filter(
      (name) => name.length >= 6 && !/^(?:fetch|default|anonymous|handler|process)$/i.test(name),
    );
  return {
    messages: [...messages].slice(0, 4),
    identifiers: [...new Set(identifiers)].slice(0, 4),
  };
}

/** @param {PreparedRepository} prepared @param {string} pattern @param {string} flags */
async function grepCommit(prepared, pattern, flags) {
  // git grep exits 1 without matches, which is an answer, not a failure.
  const out = await run(
    "git -C " +
      quote(prepared.repoPath) +
      " grep -n -I " +
      flags +
      " -e " +
      quote(pattern) +
      " " +
      quote(prepared.commit) +
      " -- " +
      SOURCE_GLOBS +
      " | head -40 || true",
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^[a-f0-9]{40}:([^:]+):(\d+):(.*)$/.exec(line);
      return match && { path: match[1], line: Number(match[2]), code: match[3] };
    })
    .filter((hit) => hit !== null);
}

/**
 * Ranks the files that most likely produced the alert, using alert data and never alert
 * instructions. Without any match it returns no candidates; the code investigator searches anyway.
 * @param {string} alert @param {PreparedRepository} prepared
 */
export async function discoverIncidentSource(alert, prepared) {
  const search = alertSearchTerms(alert);
  /** @type {Map<string, SourceCandidate>} */
  const found = new Map();
  /** @param {string} path @param {number} line @param {number} score @param {string} matchedBy */
  const add = (path, line, score, matchedBy) => {
    const candidate = found.get(path);
    if (!candidate) {
      found.set(path, { path, score, matchedBy, lines: [line] });
      return;
    }
    if (!candidate.lines.includes(line)) {
      candidate.lines.push(line);
    }
    if (score > candidate.score) {
      candidate.score = score;
      candidate.matchedBy = matchedBy;
    }
  };

  for (const message of search.messages) {
    for (const hit of await grepCommit(prepared, message, "-F")) {
      const raises = /throw|new \w*Error|console\.(?:error|warn)|logger\./.test(hit.code);
      add(hit.path, hit.line, 100 + (raises ? 20 : 0), "error-text");
    }
  }
  for (const name of search.identifiers) {
    const definition =
      "(function|class|const|let|async)[[:space:]]+" +
      name +
      "([^A-Za-z0-9_$]|$)|(^|[^A-Za-z0-9_$.])" +
      name +
      "[[:space:]]*[:=][[:space:]]*(async[[:space:]]*)?\\(";
    for (const hit of await grepCommit(prepared, definition, "-E")) {
      add(hit.path, hit.line, 40 + (/function|class/.test(hit.code) ? 10 : 0), "stack-frame");
    }
  }

  const candidates = [...found.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 4);
  if (candidates.length < 4) {
    // Path-name matching is only a fallback: it finds files by topic, not the code that failed.
    const names = await run(
      "git -C " + quote(prepared.repoPath) + " ls-tree -r --name-only " + quote(prepared.commit),
    );
    const words =
      decodeSlack(alert)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .match(/[a-z][a-z0-9-]{3,}/g) || [];
    const terms = [...new Set(words.filter((word) => !STOP_WORDS.has(word)))].slice(0, 60);
    const ranked = names
      .trim()
      .split("\n")
      .filter(
        (path) =>
          /\.(?:ts|tsx|js|mjs)$/.test(path) &&
          !found.has(path) &&
          !/node_modules|\.test\.|\.spec\.|\/fixtures\/|generated|\.env|credentials|secrets|private[-_]?key/i.test(
            path,
          ),
      )
      .map((path) => {
        const lower = path.toLowerCase();
        const score = terms.reduce(
          (total, word) => total + (lower.includes(word) ? Math.min(word.length, 12) : 0),
          0,
        );
        return { path, score, matchedBy: "path-name", lines: /** @type {number[]} */ ([]) };
      })
      .filter((candidate) => candidate.score > 3)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    candidates.push(...ranked.slice(0, 4 - candidates.length));
  }

  return {
    repository: prepared.repository,
    commit: prepared.commit,
    deploymentVerified: false,
    search,
    terms: [...search.messages, ...search.identifiers],
    candidates,
  };
}

/**
 * Which Cloudflare Workers this repository deploys, from top-level wrangler names, and whether
 * the alert's service is one of them.
 * @param {PreparedRepository} prepared @param {string | null} service
 */
export async function findServiceDeployment(prepared, service) {
  const out = await run(
    "git -C " +
      quote(prepared.repoPath) +
      " grep -n -E " +
      quote('^[[:space:]]{0,4}"name"[[:space:]]*:') +
      " " +
      quote(prepared.commit) +
      " -- '*wrangler*.json' '*wrangler*.jsonc' ':!*/tests/*' | head -40",
  );
  const deployed = out
    .split("\n")
    .map((line) => /^[a-f0-9]{40}:([^:]+):\d+:\s*"name"\s*:\s*"([^"]+)"/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ name: match[2], config: match[1] }));
  const match = deployed.find((worker) => worker.name === service);
  return {
    service,
    deployedFromRepository: match ? match.config : null,
    repositoryWorkers: deployed.map((worker) => worker.name),
  };
}

/**
 * Reads one candidate file at the pinned commit and keeps up to two numbered excerpts, centred on
 * the lines that matched the alert.
 * @param {{ repository: string, commit: string, terms: string[], candidates: SourceCandidate[] }} discovery
 * @param {PreparedRepository} prepared
 * @param {string} path
 */
export async function fetchIncidentSource(discovery, prepared, path) {
  const output = await run(
    "set -e; git -C " +
      quote(prepared.repoPath) +
      " cat-file -e " +
      quote(discovery.commit + ":" + path) +
      "; git -C " +
      quote(prepared.repoPath) +
      " show " +
      quote(discovery.commit + ":" + path) +
      " | python3 -c " +
      quote(
        'import sys,json,base64; b=sys.stdin.buffer.read(250001); print(json.dumps(dict(type="file",encoding="base64",size=len(b),content=base64.b64encode(b).decode())))',
      ),
  );
  const body = JSON.parse(output);
  if (body.type !== "file" || body.encoding !== "base64" || body.size > 250000) {
    throw new Error("Expected a bounded base64 implementation file: " + path);
  }
  const decoded = new TextDecoder().decode(
    Uint8Array.from(atob(body.content.replace(/\s/g, "")), (char) => char.charCodeAt(0)),
  );
  const lines = decoded.split("\n");
  const candidate = discovery.candidates.find((entry) => entry.path === path);

  // Without matched lines, score each line by the alert's terms instead.
  const hits = candidate?.lines?.length
    ? candidate.lines.map((line) => ({ index: line - 1 }))
    : lines
        .map((line, index) => ({
          index,
          score:
            discovery.terms.reduce(
              (total, term) =>
                total +
                (line.toLowerCase().includes(term.toLowerCase()) ? Math.min(term.length, 12) : 0),
              0,
            ) + (/throw new \w*Error|!response\.ok/.test(line) ? 12 : 0),
        }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index);

  /** @type {{ fromLine: number, toLine: number, url: string, numberedSource: string }[]} */
  const excerpts = [];
  for (const hit of hits.length ? hits : [{ index: 0 }]) {
    if (
      excerpts.some(
        (excerpt) => hit.index + 1 >= excerpt.fromLine && hit.index + 1 <= excerpt.toLine,
      )
    ) {
      continue;
    }
    const fromLine = Math.max(1, hit.index - 12);
    const toLine = Math.min(lines.length, hit.index + 23);
    const numberedSource = lines
      .slice(fromLine - 1, toLine)
      .map((line, offset) => fromLine + offset + ": " + line.slice(0, 400))
      .join("\n");
    const url =
      "https://github.com/" +
      discovery.repository +
      "/blob/" +
      discovery.commit +
      "/" +
      path +
      "#L" +
      fromLine +
      "-L" +
      toLine;
    excerpts.push({ fromLine, toLine, url, numberedSource });
    if (excerpts.length === 2) {
      break;
    }
  }

  return {
    repository: discovery.repository,
    commit: discovery.commit,
    path,
    matchedBy: candidate ? candidate.matchedBy : "path-name",
    matchedLines: candidate ? candidate.lines : [],
    totalLines: lines.length,
    deploymentVerified: false,
    excerpts,
  };
}
