/**
 * @import { Rule } from 'eslint'
 */

/** @type {Rule.RuleModule} */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Prefer `assert` over `expect(...).toBe` + guard",
      category: "Best Practices",
    },
    fixable: "code",
    schema: [],
    messages: {
      replaceWithAssert:
        'Use `assert({{expression}} === "json")` instead of `expect(...).toBe("json")` + guard.',
    },
  },

  create(context) {
    const sourceCode = context.getSourceCode();
    let hasRelevantMatch = false;

    /** @param {any} node */
    const normalize = (node) => {
      if (!node) {
        return node;
      }
      if (node.type === "ChainExpression") {
        return node.expression;
      }
      if (node.type === "TSNonNullExpression" || node.type === "TSAsExpression") {
        return node.expression;
      }
      return node;
    };

    /** @param {any} node */
    const isJsonLiteral = (node) => node?.type === "Literal" && node.value === "json";

    /** @param {any} node */
    const toBeExpression = (node) => {
      if (node?.type !== "ExpressionStatement") {
        return null;
      }

      const expr = node.expression;
      if (expr?.type !== "CallExpression") {
        return null;
      }

      if (expr.callee?.type !== "MemberExpression" || expr.callee.computed) {
        return null;
      }

      if (expr.callee.property.type !== "Identifier" || expr.callee.property.name !== "toBe") {
        return null;
      }

      const expectCall = normalize(expr.callee.object);
      if (expectCall?.type !== "CallExpression") {
        return null;
      }

      if (expectCall.callee?.type !== "Identifier" || expectCall.callee.name !== "expect") {
        return null;
      }

      if (expectCall.arguments.length !== 1 || expr.arguments.length !== 1) {
        return null;
      }

      if (!isJsonLiteral(expr.arguments[0])) {
        return null;
      }

      const value = normalize(expectCall.arguments[0]);
      if (value?.type !== "MemberExpression" || value.computed) {
        return null;
      }

      if (value.property.type !== "Identifier" || value.property.name !== "type") {
        return null;
      }

      return value;
    };

    /**
     * @param {any} a
     * @param {any} b
     * @returns {boolean}
     */
    const sameExpr = (a, b) => {
      const left = normalize(a);
      const right = normalize(b);

      if (!left || !right || left.type !== right.type) {
        return false;
      }

      if (left.type === "Identifier") {
        return left.name === right.name;
      }

      if (left.type === "ThisExpression") {
        return true;
      }

      if (left.type === "Literal") {
        return left.value === right.value;
      }

      if (left.type === "MemberExpression") {
        if (left.computed || right.computed) {
          return false;
        }

        return (
          left.property.type === "Identifier" &&
          right.property.type === "Identifier" &&
          left.property.name === right.property.name &&
          sameExpr(left.object, right.object)
        );
      }

      return false;
    };

    /**
     * @param {any} node
     * @param {any} expr
     */
    const isJsonGuardIf = (node, expr) => {
      if (!node || node.type !== "IfStatement") {
        return false;
      }

      if (node.consequent.type !== "BlockStatement" || node.consequent.body.length !== 1) {
        return false;
      }

      const statement = node.consequent.body[0];
      if (statement.type !== "ReturnStatement" && statement.type !== "ThrowStatement") {
        return false;
      }

      const test = node.test;
      if (test?.type !== "BinaryExpression" || test.operator !== "!==") {
        return false;
      }

      return isJsonLiteral(test.right) && sameExpr(test.left, expr);
    };

    return {
      "BlockStatement:exit"(node) {
        const { body } = node;
        if (!Array.isArray(body) || body.length < 2) {
          return;
        }

        for (let i = 0; i < body.length - 1; i += 1) {
          const expectStmt = body[i];
          const ifStmt = body[i + 1];

          const expr = toBeExpression(expectStmt);
          if (!expr || !isJsonGuardIf(ifStmt, expr)) {
            continue;
          }

          hasRelevantMatch = true;
          context.report({
            node: ifStmt,
            messageId: "replaceWithAssert",
            data: { expression: sourceCode.getText(expr) },
            fix(fixer) {
              if (!expectStmt.range || !ifStmt.range) {
                return null;
              }

              const replacement = `assert(${sourceCode.getText(expr)} === "json");\n`;
              return fixer.replaceTextRange([expectStmt.range[0], ifStmt.range[1]], replacement);
            },
          });
        }
      },

      "Program:exit"(node) {
        if (!hasRelevantMatch) {
          return;
        }

        /** @type {any | null} */
        const vitestImport = node.body.find(
          (statement) =>
            statement.type === "ImportDeclaration" &&
            statement.source.type === "Literal" &&
            statement.source.value === "vitest",
        );

        /** @param {any} importDecl */
        const hasAssertSpecifier = (importDecl) => {
          return importDecl?.specifiers?.some(
            /** @param {any} specifier */
            (specifier) =>
              specifier.type === "ImportSpecifier" && specifier.local.name === "assert",
          );
        };

        const insertImport = () => {
          const insertion = `import { assert } from "vitest";\n`;
          const insertAt = node.body.length > 0 ? node.body[0] : null;
          if (!insertAt) {
            context.report({
              node,
              message: "Add assert import from vitest",
              fix: (fixer) => fixer.insertTextAfterRange([0, 0], insertion),
            });
            return;
          }

          context.report({
            node,
            message: "Add assert import from vitest",
            fix(fixer) {
              return fixer.insertTextBefore(insertAt, insertion);
            },
          });
        };

        if (!vitestImport) {
          insertImport();
          return;
        }

        if (hasAssertSpecifier(vitestImport)) {
          return;
        }

        const namedSpecifiers = vitestImport.specifiers.filter(
          /** @param {any} s */
          (s) => s.type === "ImportSpecifier",
        );

        if (namedSpecifiers.length > 0) {
          const lastSpecifier = namedSpecifiers[namedSpecifiers.length - 1];
          context.report({
            node: vitestImport,
            message: "Add assert import from vitest",
            fix(fixer) {
              return fixer.insertTextAfter(lastSpecifier, ", assert");
            },
          });
          return;
        }

        insertImport();
      },
    };
  },
};

const plugin = {
  meta: {
    name: "vitest-assert-json-response",
    version: "1.0.0",
  },
  rules: {
    "assert-json-response": rule,
  },
};

export default plugin;
