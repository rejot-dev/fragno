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
      description: "Ensure fragment browser exports point at dist outputs",
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
          const exportsMap = packageJson.exports;

          if (!exportsMap) {
            return;
          }

          const deps = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies,
            ...packageJson.peerDependencies,
            ...packageJson.optionalDependencies,
          };

          const sourceCode = context.sourceCode.getText();
          const usesUnplugin =
            Object.prototype.hasOwnProperty.call(deps, "@fragno-dev/unplugin-fragno") ||
            sourceCode.includes("unpluginFragno") ||
            sourceCode.includes("@fragno-dev/unplugin-fragno");
          const hasBrowserBuild = sourceCode.includes('platform: "browser"');
          const isExplicitFragment = packageJson.fragno?.fragment === true;

          if (!(isExplicitFragment || (usesUnplugin && hasBrowserBuild))) {
            return;
          }

          /** @type {string[]} */
          const problems = [];

          for (const [exportKey, exportValue] of Object.entries(exportsMap)) {
            if (exportKey === "./package.json") {
              continue;
            }

            if (!exportValue || typeof exportValue !== "object") {
              continue;
            }

            const browserPath = exportValue.browser;
            if (browserPath === undefined) {
              continue;
            }

            if (typeof browserPath !== "string") {
              problems.push(`${exportKey} browser export must be a string`);
              continue;
            }

            if (!browserPath.startsWith("./dist/")) {
              problems.push(`${exportKey} browser export should point to dist output`);
            }
          }

          if (problems.length > 0) {
            context.report({
              node,
              message: problems.join("; "),
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
    name: "fragment-dev-browser-exports",
    version: "1.0.0",
  },
  rules: {
    "exports-match": rule,
  },
};

export default plugin;
