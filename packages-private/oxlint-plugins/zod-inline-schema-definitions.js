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
 * @returns {boolean}
 */
const isZodCallee = (node) => {
  const expression = unwrapExpression(node);

  if (!expression) {
    return false;
  }

  if (expression.type === "Identifier") {
    return expression.name === "z";
  }

  if (expression.type === "MemberExpression") {
    return isZodCallee(expression.object);
  }

  if (expression.type === "CallExpression") {
    return isZodExpression(expression);
  }

  return false;
};

/**
 * @param {any} node
 * @returns {boolean}
 */
const isZodExpression = (node) => {
  const expression = unwrapExpression(node);
  return expression?.type === "CallExpression" && isZodCallee(expression.callee);
};

/**
 * @param {any} node
 * @returns {boolean}
 */
const isExportedDeclaration = (node) => {
  const parent = node?.parent;
  return parent?.type === "ExportNamedDeclaration" || parent?.type === "ExportDefaultDeclaration";
};

/**
 * @param {any} identifier
 * @returns {boolean}
 */
const isTypePosition = (identifier) => {
  let current = identifier.parent;

  while (current) {
    if (typeof current.type === "string" && current.type.startsWith("TS")) {
      return true;
    }

    if (
      current.type === "Program" ||
      current.type === "BlockStatement" ||
      current.type === "StaticBlock"
    ) {
      return false;
    }

    current = current.parent;
  }

  return false;
};

/**
 * @param {any} identifier
 * @returns {boolean}
 */
const isExportReference = (identifier) => {
  let current = identifier.parent;

  while (current) {
    if (
      current.type === "ExportSpecifier" ||
      current.type === "ExportNamedDeclaration" ||
      current.type === "ExportDefaultDeclaration"
    ) {
      return true;
    }

    if (current.type === "Program" || current.type === "BlockStatement") {
      return false;
    }

    current = current.parent;
  }

  return false;
};

/**
 * @param {any} identifier
 * @returns {boolean}
 */
const isShorthandPropertyValue = (identifier) => {
  const parent = identifier.parent;
  return parent?.type === "Property" && parent.shorthand === true && parent.value === identifier;
};

/**
 * @param {any} identifier
 * @returns {boolean}
 */
const isUnsafeReference = (identifier) => {
  if (!identifier?.range) {
    return true;
  }

  if (isTypePosition(identifier) || isExportReference(identifier)) {
    return true;
  }

  const parent = identifier.parent;

  if (
    parent?.type === "MemberExpression" &&
    parent.property === identifier &&
    parent.computed !== true
  ) {
    return true;
  }

  if (parent?.type === "Property" && parent.key === identifier && !parent.shorthand) {
    return true;
  }

  if (parent?.type === "PropertyDefinition" && parent.key === identifier && !parent.computed) {
    return true;
  }

  return false;
};

/**
 * @param {string} sourceText
 * @param {any} statement
 * @returns {[number, number] | null}
 */
const declarationRemovalRange = (sourceText, statement) => {
  if (!statement?.range) {
    return null;
  }

  const [start, end] = statement.range;
  let removalEnd = end;

  while (removalEnd < sourceText.length && /[\t ]/.test(sourceText[removalEnd])) {
    removalEnd += 1;
  }

  if (sourceText[removalEnd] === "\r" && sourceText[removalEnd + 1] === "\n") {
    removalEnd += 2;
  } else if (sourceText[removalEnd] === "\n") {
    removalEnd += 1;
  }

  return [start, removalEnd];
};

/**
 * @param {any} inner
 * @param {any} outer
 * @returns {boolean}
 */
const isInsideRange = (inner, outer) =>
  Boolean(
    inner?.range &&
    outer?.range &&
    inner.range[0] >= outer.range[0] &&
    inner.range[1] <= outer.range[1],
  );

/** @type {Rule.RuleModule} */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Inline one-line Zod schema constants at their use sites",
      category: "Best Practices",
    },
    fixable: "code",
    schema: [],
    messages: {
      inlineSchemas: "Inline one-line Zod schema definitions.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;
    const sourceText = sourceCode.getText();
    let hasZodImport = false;
    /** @type {Array<{ declaration: any, init: any, name: string, node: any, readReferences: any[], removeRange: [number, number], variable: any }>} */
    const candidates = [];

    /**
     * @param {{ init: any, name: string }} candidate
     * @param {Set<string>} [seen]
     * @returns {string}
     */
    const expandedInitText = (candidate, seen = new Set()) => {
      if (seen.has(candidate.name)) {
        return sourceCode.getText(candidate.init);
      }

      seen.add(candidate.name);

      const replacements = [];
      for (const dependency of candidates) {
        if (dependency.name === candidate.name) {
          continue;
        }

        for (const reference of dependency.readReferences) {
          const identifier = reference.identifier;
          if (!isInsideRange(identifier, candidate.init)) {
            continue;
          }

          const dependencyText = expandedInitText(dependency, seen);
          if (isShorthandPropertyValue(identifier)) {
            replacements.push({
              range: identifier.parent.range,
              text: `${dependency.name}: ${dependencyText}`,
            });
            continue;
          }

          replacements.push({ range: identifier.range, text: dependencyText });
        }
      }

      seen.delete(candidate.name);

      let text = sourceCode.getText(candidate.init);
      for (const replacement of replacements.sort((a, b) => b.range[0] - a.range[0])) {
        const start = replacement.range[0] - candidate.init.range[0];
        const end = replacement.range[1] - candidate.init.range[0];
        text = `${text.slice(0, start)}${replacement.text}${text.slice(end)}`;
      }

      return text;
    };

    return {
      /** @param {any} node */
      Program(node) {
        hasZodImport = node.body.some(
          /** @param {any} statement */
          (statement) =>
            statement.type === "ImportDeclaration" &&
            statement.source?.value === "zod" &&
            statement.specifiers.some(
              /** @param {any} specifier */
              (specifier) => specifier.local?.name === "z",
            ),
        );
      },

      /** @param {any} node */
      VariableDeclarator(node) {
        const declaration = node.parent;

        if (
          !hasZodImport ||
          declaration?.type !== "VariableDeclaration" ||
          declaration.parent?.type !== "Program" ||
          declaration.kind !== "const" ||
          declaration.declarations.length !== 1 ||
          isExportedDeclaration(declaration) ||
          node.id?.type !== "Identifier" ||
          !node.init ||
          !node.range ||
          !declaration.range ||
          declaration.loc?.start.line !== declaration.loc?.end.line ||
          node.init.loc?.start.line !== node.init.loc?.end.line ||
          !isZodExpression(node.init)
        ) {
          return;
        }

        const variables = sourceCode.getDeclaredVariables(node);
        const variable = variables[0];
        if (!variable) {
          return;
        }

        const readReferences = variable.references.filter(
          /** @param {any} reference */
          (reference) =>
            reference.identifier !== node.id &&
            typeof reference.isRead === "function" &&
            reference.isRead(),
        );

        if (readReferences.length === 0) {
          return;
        }

        if (
          readReferences.some(
            /** @param {any} reference */
            (reference) => isUnsafeReference(reference.identifier),
          )
        ) {
          return;
        }

        const removeRange = declarationRemovalRange(sourceText, declaration);
        if (!removeRange) {
          return;
        }

        candidates.push({
          declaration,
          init: node.init,
          name: node.id.name,
          node,
          readReferences,
          removeRange,
          variable,
        });
      },

      "Program:exit"() {
        if (candidates.length === 0) {
          return;
        }

        /** @param {any} identifier */
        const isInsideRemovedDeclaration = (identifier) =>
          candidates.some(
            (candidate) =>
              identifier.range[0] >= candidate.removeRange[0] &&
              identifier.range[1] <= candidate.removeRange[1],
          );

        context.report({
          node: candidates[0].node,
          messageId: "inlineSchemas",
          fix(fixer) {
            const fixes = candidates.map((candidate) =>
              fixer.replaceTextRange(candidate.removeRange, ""),
            );

            for (const candidate of candidates) {
              const initText = expandedInitText(candidate);

              for (const reference of candidate.readReferences) {
                const identifier = reference.identifier;
                if (isInsideRemovedDeclaration(identifier)) {
                  continue;
                }

                if (isShorthandPropertyValue(identifier)) {
                  fixes.push(
                    fixer.replaceTextRange(
                      identifier.parent.range,
                      `${candidate.name}: ${initText}`,
                    ),
                  );
                  continue;
                }

                fixes.push(fixer.replaceTextRange(identifier.range, initText));
              }
            }

            return fixes;
          },
        });
      },
    };
  },
};

const plugin = {
  meta: {
    name: "zod-inline-schema-definitions",
    version: "1.0.0",
  },
  rules: {
    "inline-one-line": rule,
  },
};

export default plugin;
