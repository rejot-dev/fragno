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
          const developmentPaths = new Set();

          for (const [exportKey, exportValue] of Object.entries(packageJson.exports)) {
            if (exportKey === "./package.json") {
              continue;
            }

            if (typeof exportValue === "string") {
              continue;
            } else if (typeof exportValue === "object" && exportValue !== null) {
              if (exportValue.development) {
                if (typeof exportValue.development === "string") {
                  developmentPaths.add(exportValue.development);
                } else if (typeof exportValue.development === "object") {
                  if (exportValue.development.default) {
                    developmentPaths.add(exportValue.development.default);
                  } else {
                    for (const [key, devPath] of Object.entries(exportValue.development)) {
                      if (typeof devPath === "string" && key !== "browser") {
                        developmentPaths.add(devPath);
                        break;
                      }
                    }
                  }
                }
              }

              if (exportValue.workerd?.development) {
                developmentPaths.add(exportValue.workerd.development);
              }
            }
          }

          if (developmentPaths.size === 0) {
            return;
          }

          const sourceCode = context.sourceCode.getText();
          /** @type {Set<string>} */
          const tsdownEntries = new Set();

          const entryMatch = sourceCode.match(/entry:\s*(\[[\s\S]*?\]|["'][^"']+["'])/);

          if (entryMatch) {
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
          for (const devPath of developmentPaths) {
            if (!pathMatchesEntry(devPath)) {
              missingEntries.push(devPath);
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
