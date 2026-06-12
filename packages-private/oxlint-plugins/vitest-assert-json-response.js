/**
 * @import { Rule } from 'eslint'
 */

/** @type {Rule.RuleModule} */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Prefer `assert` over `expect(...).toBe(...)`",
      category: "Best Practices",
    },
    fixable: "code",
    schema: [],
    messages: {
      replaceWithAssert: "Use `assert` instead of `expect(...).toBe(...)`.",
    },
  },

  create(context) {
    const sourceCode = context.getSourceCode();
    let hasRelevantMatch = false;
    /** @type {Array<[number, number]>} */
    const replacedRanges = [];

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
    const isSimpleExpected = (node) => {
      const value = normalize(node);
      if (!value) {
        return false;
      }

      if (value.type === "Literal") {
        return !value.regex;
      }

      if (value.type === "TemplateLiteral") {
        return value.expressions.length === 0;
      }

      if (value.type === "Identifier") {
        return value.name === "undefined" || value.name === "NaN" || value.name === "Infinity";
      }

      if (value.type === "UnaryExpression") {
        return (
          (value.operator === "-" || value.operator === "+") &&
          value.argument.type === "Literal" &&
          typeof value.argument.value === "number"
        );
      }

      return false;
    };

    /** @param {any} expr */
    const toBeCall = (expr) => {
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

      const actual = normalize(expectCall.arguments[0]);
      const expected = normalize(expr.arguments[0]);
      if (!isSimpleExpected(expected)) {
        return null;
      }

      if (booleanLiteralValue(expected) === null && actual?.type === "Identifier") {
        return null;
      }

      return { actual, expected };
    };

    /** @param {any} statement */
    const toBeAssertion = (statement) => {
      if (statement?.type !== "ExpressionStatement") {
        return null;
      }

      return toBeCall(statement.expression);
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

    /** @param {any} node */
    const isAbruptSingleStatementIf = (node) => {
      if (!node || node.type !== "IfStatement") {
        return false;
      }

      if (node.consequent.type !== "BlockStatement" || node.consequent.body.length !== 1) {
        return false;
      }

      const statement = node.consequent.body[0];
      return statement.type === "ReturnStatement" || statement.type === "ThrowStatement";
    };

    /**
     * @param {any} node
     * @param {any} actual
     * @param {boolean} expected
     */
    const isBooleanGuardIf = (node, actual, expected) => {
      if (!isAbruptSingleStatementIf(node)) {
        return false;
      }

      const test = node.test;
      if (expected) {
        return (
          test?.type === "UnaryExpression" &&
          test.operator === "!" &&
          sameExpr(test.argument, actual)
        );
      }

      return sameExpr(test, actual);
    };

    /** @param {any} actual */
    const booleanAssertionText = (actual) => {
      const value = normalize(actual);
      if (
        value?.type === "CallExpression" &&
        value.callee.type === "Identifier" &&
        value.callee.name === "Boolean" &&
        value.arguments.length === 1
      ) {
        return sourceCode.getText(value.arguments[0]);
      }

      return sourceCode.getText(actual);
    };

    /** @param {any} expected */
    const booleanLiteralValue = (expected) => {
      const value = normalize(expected);
      if (value?.type !== "Literal" || typeof value.value !== "boolean") {
        return null;
      }

      return value.value;
    };

    /**
     * @param {string} actualText
     * @param {string} expectedText
     * @param {any} actual
     * @param {any} expected
     */
    const toAssertStatement = (actualText, expectedText, actual, expected) => {
      const expectedBoolean = booleanLiteralValue(expected);
      if (expectedBoolean === true) {
        return `assert(${booleanAssertionText(actual)});`;
      }

      if (expectedBoolean === false) {
        return `assert(!(${booleanAssertionText(actual)}));`;
      }

      return `assert(${actualText} === ${expectedText});`;
    };

    /** @param {any} node */
    const hasPreviousTsDirective = (node) => {
      if (!node?.range) {
        return false;
      }

      const sourceText = sourceCode.getText();
      const currentLineStart = sourceText.lastIndexOf("\n", node.range[0] - 1) + 1;
      const previousLineEnd = currentLineStart - 1;
      if (previousLineEnd <= 0) {
        return false;
      }

      const previousLineStart = sourceText.lastIndexOf("\n", previousLineEnd - 1) + 1;
      const previousLine = sourceText.slice(previousLineStart, previousLineEnd);
      return previousLine.includes("@ts-expect-error") || previousLine.includes("@ts-ignore");
    };

    return {
      "ArrowFunctionExpression:exit"(node) {
        const assertion = toBeCall(node.body);
        if (!assertion || hasPreviousTsDirective(node.body)) {
          return;
        }

        const actualText = sourceCode.getText(assertion.actual);
        const expectedText = sourceCode.getText(assertion.expected);
        hasRelevantMatch = true;
        if (node.body.range) {
          replacedRanges.push(node.body.range);
        }

        context.report({
          node: node.body,
          messageId: "replaceWithAssert",
          data: { actual: actualText, expected: expectedText },
          fix(fixer) {
            if (!node.body.range) {
              return null;
            }

            const assertExpression = toAssertStatement(
              actualText,
              expectedText,
              assertion.actual,
              assertion.expected,
            );
            return fixer.replaceTextRange(node.body.range, assertExpression.slice(0, -1));
          },
        });
      },

      "BlockStatement:exit"(node) {
        const { body } = node;
        if (!Array.isArray(body)) {
          return;
        }

        for (let i = 0; i < body.length; i += 1) {
          const expectStmt = body[i];
          const nextStmt = body[i + 1];

          const assertion = toBeAssertion(expectStmt);
          if (!assertion || hasPreviousTsDirective(expectStmt)) {
            continue;
          }

          const actualText = sourceCode.getText(assertion.actual);
          const expectedText = sourceCode.getText(assertion.expected);
          const expectedBoolean = booleanLiteralValue(assertion.expected);
          const removeGuard =
            expectedBoolean !== null &&
            isBooleanGuardIf(nextStmt, assertion.actual, expectedBoolean);
          const assertStatement = toAssertStatement(
            actualText,
            expectedText,
            assertion.actual,
            assertion.expected,
          );
          const replacementEnd = removeGuard ? nextStmt : expectStmt;

          hasRelevantMatch = true;
          if (expectStmt.range) {
            replacedRanges.push(expectStmt.range);
          }

          context.report({
            node: expectStmt,
            messageId: "replaceWithAssert",
            data: { actual: actualText, expected: expectedText },
            fix(fixer) {
              if (!expectStmt.range || !replacementEnd?.range) {
                return null;
              }

              return fixer.replaceTextRange(
                [expectStmt.range[0], replacementEnd.range[1]],
                assertStatement,
              );
            },
          });
        }
      },

      "Program:exit"(node) {
        /** @type {any | null} */
        const vitestImport = node.body.find(
          (statement) =>
            statement.type === "ImportDeclaration" &&
            statement.source.type === "Literal" &&
            statement.source.value === "vitest",
        );

        /** @param {any} candidate */
        const isInsideReplacedRange = (candidate) => {
          if (!candidate?.range) {
            return false;
          }

          return replacedRanges.some(
            ([start, end]) => candidate.range[0] >= start && candidate.range[1] <= end,
          );
        };

        const hasExpectUsage = () => {
          /** @param {any} candidate */
          const visit = (candidate) => {
            if (!candidate || typeof candidate !== "object") {
              return false;
            }

            if (candidate.type === "ImportDeclaration" || isInsideReplacedRange(candidate)) {
              return false;
            }

            if (candidate.type === "Identifier" && candidate.name === "expect") {
              return true;
            }

            for (const [key, value] of Object.entries(candidate)) {
              if (key === "parent" || key === "range" || key === "loc") {
                continue;
              }

              if (Array.isArray(value)) {
                if (value.some((item) => visit(item))) {
                  return true;
                }
                continue;
              }

              if (visit(value)) {
                return true;
              }
            }

            return false;
          };

          return visit(node);
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
          if (hasRelevantMatch) {
            insertImport();
          }
          return;
        }

        const namedSpecifiers = vitestImport.specifiers.filter(
          /** @param {any} s */
          (s) => s.type === "ImportSpecifier",
        );
        const hasAssertSpecifier = namedSpecifiers.some(
          /** @param {any} specifier */
          (specifier) => specifier.local.name === "assert",
        );
        const hasExpectSpecifier = namedSpecifiers.some(
          /** @param {any} specifier */
          (specifier) => specifier.local.name === "expect",
        );
        const shouldAddAssert = hasRelevantMatch && !hasAssertSpecifier;
        const shouldRemoveExpect = hasExpectSpecifier && !hasExpectUsage();

        if (!shouldAddAssert && !shouldRemoveExpect) {
          return;
        }

        const nextSpecifiers = namedSpecifiers
          .filter(
            /** @param {any} specifier */
            (specifier) => !shouldRemoveExpect || specifier.local.name !== "expect",
          )
          .map(
            /** @param {any} specifier */
            (specifier) => sourceCode.getText(specifier),
          );

        if (shouldAddAssert) {
          nextSpecifiers.push("assert");
        }

        context.report({
          node: vitestImport,
          message: shouldAddAssert
            ? "Add assert import from vitest"
            : "Remove unused expect import",
          fix(fixer) {
            if (!vitestImport.range) {
              return null;
            }

            return fixer.replaceTextRange(
              vitestImport.range,
              `import { ${nextSpecifiers.join(", ")} } from "vitest";`,
            );
          },
        });
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
