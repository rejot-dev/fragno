import fs from "node:fs";
import path from "node:path";

/**
 * @import { Rule } from 'eslint'
 */

const TARGET_SUFFIX = "/apps/docs/app/lib/icons.tsx";

/**
 * @param {string} filename
 * @returns {boolean}
 */
function isTargetFile(filename) {
  const normalized = filename.replace(/\\/g, "/");
  return normalized.endsWith(TARGET_SUFFIX);
}

/**
 * @param {string} sourceText
 * @returns {Set<string>}
 */
function extractIconComponentKeys(sourceText) {
  const match = sourceText.match(/iconComponents\s*=\s*{([\s\S]*?)}\s*as\s+const/);
  if (!match) {
    return new Set();
  }

  let body = match[1];
  body = body.replace(/\/\*[\s\S]*?\*\//g, "");
  body = body.replace(/\/\/.*$/gm, "");

  /** @type {Set<string>} */
  const keys = new Set();
  const propRegex = /(^\s*|[,{]\s*)([A-Za-z_$][\w$]*|["'][^"']+["'])\s*(?=,|:)/g;
  let propMatch = propRegex.exec(body);

  while (propMatch) {
    const rawKey = propMatch[2];
    const key = rawKey.replace(/^["']|["']$/g, "");
    if (key) {
      keys.add(key);
    }
    propMatch = propRegex.exec(body);
  }

  return keys;
}

/**
 * @param {any} expr
 * @returns {any}
 */
function unwrapExpression(expr) {
  let current = expr;

  while (current && typeof current === "object") {
    if (
      current.type === "TSAsExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSParenthesizedExpression"
    ) {
      current = current.expression;
      continue;
    }
    break;
  }

  return current;
}

/**
 * @param {any} node
 * @param {Set<string>} keys
 */
function collectKeysFromObjectExpression(node, keys) {
  if (!node || node.type !== "ObjectExpression") {
    return;
  }

  for (const property of node.properties || []) {
    if (!property || property.type !== "Property") {
      continue;
    }

    if (property.computed) {
      continue;
    }

    const keyNode = property.key;
    if (!keyNode) {
      continue;
    }

    if (keyNode.type === "Identifier" && keyNode.name) {
      keys.add(keyNode.name);
      continue;
    }

    if (keyNode.type === "Literal" && typeof keyNode.value === "string") {
      keys.add(keyNode.value);
    }
  }
}

/**
 * @param {any} ast
 * @returns {Set<string> | null}
 */
function extractIconComponentKeysFromAst(ast) {
  if (!ast || !Array.isArray(ast.body)) {
    return null;
  }

  /** @type {Set<string>} */
  const keys = new Set();

  for (const statement of ast.body) {
    if (!statement || typeof statement !== "object") {
      continue;
    }

    let declaration = statement;
    if (statement.type === "ExportNamedDeclaration" && statement.declaration) {
      declaration = statement.declaration;
    }

    if (declaration.type !== "VariableDeclaration") {
      continue;
    }

    for (const declarator of declaration.declarations || []) {
      if (!declarator || declarator.type !== "VariableDeclarator") {
        continue;
      }

      if (!declarator.id || declarator.id.type !== "Identifier") {
        continue;
      }

      if (declarator.id.name !== "iconComponents") {
        continue;
      }

      const init = unwrapExpression(declarator.init);
      collectKeysFromObjectExpression(init, keys);
    }
  }

  return keys;
}

/**
 * @param {string} rawValue
 * @returns {string | null}
 */
function normalizeIconValue(rawValue) {
  let value = rawValue.trim();

  if (!value) {
    return null;
  }

  if (!value.startsWith("'") && !value.startsWith('"')) {
    const hashIndex = value.indexOf("#");
    if (hashIndex !== -1) {
      value = value.slice(0, hashIndex).trim();
    }
  }

  value = value.replace(/^["']|["']$/g, "").trim();

  if (!value) {
    return null;
  }

  if (!/^[A-Za-z0-9_$]+$/.test(value)) {
    return null;
  }

  return value;
}

/**
 * @param {string} filePath
 * @returns {string[]}
 */
function extractIconsFromMarkdown(filePath) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (_error) {
    return [];
  }

  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return [];
  }

  /** @type {string[]} */
  const icons = [];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---") {
      break;
    }

    const match = line.match(/^\s*icon\s*:\s*(.+)\s*$/);
    if (!match) {
      continue;
    }

    const normalized = normalizeIconValue(match[1]);
    if (normalized) {
      icons.push(normalized);
    }
  }

  return icons;
}

/**
 * @param {string} filePath
 * @returns {string[]}
 */
function extractIconsFromMetaJson(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(text);
    const icon = data?.icon;
    if (typeof icon === "string") {
      return [icon];
    }
  } catch (_error) {
    return [];
  }

  return [];
}

/**
 * @param {string} dirPath
 * @param {Set<string>} usedIcons
 */
function collectUsedIcons(dirPath, usedIcons) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      collectUsedIcons(entryPath, usedIcons);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
      const icons = extractIconsFromMarkdown(entryPath);
      for (const icon of icons) {
        usedIcons.add(icon);
      }
      continue;
    }

    if (entry.name === "meta.json" || entry.name.endsWith(".meta.json")) {
      const icons = extractIconsFromMetaJson(entryPath);
      for (const icon of icons) {
        usedIcons.add(icon);
      }
    }
  }
}

/** @type {Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Ensure docs icons are listed in apps/docs/app/lib/icons.tsx",
      category: "Docs",
    },
    schema: [],
  },

  create(context) {
    const filename = context.filename || context.getFilename?.();

    if (!filename || !isTargetFile(filename)) {
      return {};
    }

    return {
      /** @param {any} node */
      Program(node) {
        try {
          const sourceText = context.sourceCode.getText();
          const sourceCode = context.sourceCode ?? context.getSourceCode?.();
          const iconKeysFromAst = extractIconComponentKeysFromAst(sourceCode?.ast);
          const iconKeys = iconKeysFromAst ?? extractIconComponentKeys(sourceText);

          if (iconKeys.size === 0) {
            return;
          }

          const contentRoot = path.resolve(path.dirname(filename), "../../content");
          /** @type {Set<string>} */
          const usedIcons = new Set();
          collectUsedIcons(contentRoot, usedIcons);

          const missing = Array.from(usedIcons).filter((icon) => !iconKeys.has(icon));
          if (missing.length === 0) {
            return;
          }

          missing.sort();

          context.report({
            node,
            message: `Docs icons missing from iconComponents: ${missing.join(", ")}.`,
          });
        } catch (_error) {
          return;
        }
      },
    };
  },
};

const plugin = {
  meta: {
    name: "docs-icons-sync",
    version: "1.0.0",
  },
  rules: {
    "used-icons": rule,
  },
};

export default plugin;
