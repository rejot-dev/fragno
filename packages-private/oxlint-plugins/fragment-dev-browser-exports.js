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
      description: "Ensure fragment exports include development.browser when browser exports exist",
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
            if (typeof browserPath !== "string") {
              continue;
            }

            const development = exportValue.development;
            if (development === undefined) {
              problems.push(`${exportKey} missing development.browser`);
              continue;
            }

            if (typeof development === "string") {
              problems.push(`${exportKey} has string development export; use development.browser`);
              continue;
            }

            if (!development || typeof development !== "object") {
              problems.push(`${exportKey} development export must be an object with browser`);
              continue;
            }

            const devBrowser = development.browser;
            if (typeof devBrowser !== "string") {
              problems.push(`${exportKey} missing development.browser`);
              continue;
            }

            if (devBrowser !== browserPath) {
              problems.push(`${exportKey} development.browser should match browser export`);
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
