/**
 * @import { Rule } from 'eslint'
 */

/**
 * @param {any} node
 * @returns {any}
 */
const unwrapExpression = (node) => {
  let current = node;
  while (
    current?.type === "ChainExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
};

/**
 * @param {any} node
 * @returns {node is { type: "Identifier", name: string }}
 */
const isIdentifier = (node) => unwrapExpression(node)?.type === "Identifier";

/**
 * @param {any} specifier
 * @returns {string | null}
 */
const zodNamespaceNameFromSpecifier = (specifier) => {
  if (specifier.type === "ImportNamespaceSpecifier") {
    return specifier.local?.name ?? null;
  }

  if (specifier.type === "ImportSpecifier" && specifier.imported?.name === "z") {
    return specifier.local?.name ?? null;
  }

  return null;
};

/**
 * @param {any} callee
 * @param {Set<string>} zodNamespaceNames
 * @returns {string | null}
 */
const zodObjectNamespaceName = (callee, zodNamespaceNames) => {
  const expression = unwrapExpression(callee);
  if (
    expression?.type !== "MemberExpression" ||
    expression.computed === true ||
    expression.property?.type !== "Identifier" ||
    expression.property.name !== "object"
  ) {
    return null;
  }

  const namespace = unwrapExpression(expression.object);
  if (!isIdentifier(namespace) || !zodNamespaceNames.has(namespace.name)) {
    return null;
  }

  return namespace.name;
};

/** @type {Rule.RuleModule} */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Prefer Zod 4 top-level object factories over Zod 3 object mode methods",
      category: "Best Practices",
    },
    fixable: "code",
    schema: [],
    messages: {
      preferStrictObject: "Use z.strictObject(...) instead of z.object(...).strict().",
      preferLooseObject: "Use z.looseObject(...) instead of z.object(...).passthrough().",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;
    const sourceText = sourceCode.getText();
    const zodNamespaceNames = new Set();

    return {
      /** @param {any} node */
      Program(node) {
        for (const statement of node.body) {
          if (statement.type !== "ImportDeclaration" || statement.source?.value !== "zod") {
            continue;
          }

          for (const specifier of statement.specifiers) {
            const name = zodNamespaceNameFromSpecifier(specifier);
            if (name) {
              zodNamespaceNames.add(name);
            }
          }
        }
      },

      /** @param {any} node */
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (
          callee?.type !== "MemberExpression" ||
          callee.computed === true ||
          callee.property?.type !== "Identifier" ||
          node.arguments.length > 0
        ) {
          return;
        }

        const replacementFactory =
          callee.property.name === "strict"
            ? "strictObject"
            : callee.property.name === "passthrough"
              ? "looseObject"
              : null;
        if (!replacementFactory) {
          return;
        }

        const objectCall = unwrapExpression(callee.object);
        if (objectCall?.type !== "CallExpression" || !objectCall.range || !node.range) {
          return;
        }

        const namespaceName = zodObjectNamespaceName(objectCall.callee, zodNamespaceNames);
        if (!namespaceName || !objectCall.callee?.range) {
          return;
        }

        const openParenIndex = sourceText.indexOf("(", objectCall.callee.range[1]);
        if (openParenIndex < 0 || openParenIndex >= objectCall.range[1]) {
          return;
        }

        const argsText = sourceText.slice(openParenIndex + 1, objectCall.range[1] - 1);
        context.report({
          node,
          messageId:
            replacementFactory === "strictObject" ? "preferStrictObject" : "preferLooseObject",
          fix(fixer) {
            return fixer.replaceTextRange(
              node.range,
              `${namespaceName}.${replacementFactory}(${argsText})`,
            );
          },
        });
      },
    };
  },
};

const plugin = {
  meta: {
    name: "zod-v4-object-factories",
    version: "1.0.0",
  },
  rules: {
    "prefer-object-factories": rule,
  },
};

export default plugin;
