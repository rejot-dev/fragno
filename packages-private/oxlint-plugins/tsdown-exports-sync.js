import fs from "node:fs";
import path from "node:path";

/**
 * @import { Rule } from 'eslint'
 */

/** @type {Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Ensure tsdown.config.ts entries match package.json exports",
      category: "Build Configuration",
    },
    schema: [],
  },

  create(context) {
    const filename = context.filename || context.getFilename?.();

    if (!filename || !filename.endsWith("tsdown.config.ts")) {
      return {};
    }

    return {
      /** @param {any} node */
      Program(node) {
        try {
          const dir = path.dirname(filename);
          const packageJsonPath = path.join(dir, "package.json");

          if (!fs.existsSync(packageJsonPath)) {
            return;
          }

          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

          if (!packageJson.exports) {
            return;
          }

          /** @type {Set<string>} */
          const exportPaths = new Set();

          /**
           * @param {unknown} value
           * @param {string | undefined} key
           */
          const collectExportPaths = (value, key) => {
            if (key === "types") {
              return;
            }

            if (typeof value === "string") {
              if (value.startsWith("./dist/")) {
                exportPaths.add(value);
              }
              return;
            }

            if (!value || typeof value !== "object") {
              return;
            }

            for (const [childKey, childValue] of Object.entries(value)) {
              collectExportPaths(childValue, childKey);
            }
          };

          for (const [exportKey, exportValue] of Object.entries(packageJson.exports)) {
            if (exportKey === "./package.json") {
              continue;
            }

            collectExportPaths(exportValue, undefined);
          }

          if (exportPaths.size === 0) {
            return;
          }

          const sourceCode = context.sourceCode.getText();
          /** @type {Set<string>} */
          const tsdownEntries = new Set();

          const entryMatches = sourceCode.matchAll(/entry:\s*(\[[\s\S]*?\]|["'][^"']+["'])/g);
          for (const entryMatch of entryMatches) {
            const entryValue = entryMatch[1];

            if (entryValue.startsWith("[")) {
              const stringMatches = entryValue.matchAll(/["']([^"']+)["']/g);
              for (const match of stringMatches) {
                tsdownEntries.add(match[1]);
              }
            } else {
              const cleaned = entryValue.replace(/["']/g, "");
              tsdownEntries.add(cleaned);
            }
          }

          /**
           * @param {string} path
           * @returns {boolean}
           */
          const pathMatchesEntry = (path) => {
            const normalizedPath = path.replace(/^\.\//, "");

            if (tsdownEntries.has(path) || tsdownEntries.has(normalizedPath)) {
              return true;
            }

            for (const entry of tsdownEntries) {
              if (entry.includes("*")) {
                const normalizedEntry = entry.replace(/^\.\//, "");
                const pattern = normalizedEntry
                  .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
                  .replace(/\*/g, ".*");
                const regex = new RegExp("^" + pattern + "$");
                if (regex.test(normalizedPath)) {
                  return true;
                }
              }
            }

            return false;
          };

          /** @type {string[]} */
          const missingEntries = [];

          /** @type {(exportPath: string) => string[]} */
          const toSourceCandidates = (exportPath) => {
            if (!exportPath.startsWith("./dist/")) {
              return [];
            }

            const normalized = exportPath.replace(/^\.\//, "");
            if (!normalized.startsWith("dist/")) {
              return [];
            }

            const remainder = normalized.slice("dist/".length);
            const remainderParts = remainder.split("/");
            const remainders = [remainder];
            if (remainderParts.length > 1) {
              remainders.push(remainderParts.slice(1).join("/"));
            }

            const candidates = new Set();
            const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"];
            const prefixes = ["./src/", "./"];

            for (const item of remainders) {
              if (!item) {
                continue;
              }

              const base = item.replace(/\.js$/, "");
              for (const ext of extensions) {
                for (const prefix of prefixes) {
                  candidates.add(`${prefix}${base}${ext}`);
                }
              }
            }

            return Array.from(candidates);
          };

          for (const exportPath of exportPaths) {
            const candidates = toSourceCandidates(exportPath);
            if (candidates.length === 0) {
              continue;
            }

            const matched = candidates.some((candidate) => pathMatchesEntry(candidate));
            if (!matched) {
              missingEntries.push(exportPath);
            }
          }

          if (missingEntries.length > 0) {
            context.report({
              node,
              message: `tsdown.config.ts is missing entries for package.json exports: ${missingEntries.join(", ")}`,
            });
          }
        } catch (_error) {
          return;
        }
      },
    };
  },
};

const plugin = {
  meta: {
    name: "tsdown-exports-sync",
    version: "1.0.0",
  },
  rules: {
    "exports-match": rule,
  },
};

export default plugin;
