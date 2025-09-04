/**
 * Modified from: pcattori/vite-env-only
 * Original source: https://github.com/pcattori/vite-env-only/blob/45a39e7fb52e9fae4300e95aa51ed0880374f507/src/transform.ts
 * License: MIT
 * Date obtained: September 4 2025
 * Copyright (c) 2024 Pedro Cattori
 */

import { traverse } from "@babel/core";
import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Node } from "@babel/types";
import { name as pkgName } from "../package.json";

const macrosSpecifier = `${pkgName}/macros`;

export const isMacroBinding = (binding: Binding, macro: string): boolean => {
  if (!t.isImportDeclaration(binding?.path.parent)) return false;
  if (binding.path.parent.source.value !== macrosSpecifier) return false;

  if (!t.isImportSpecifier(binding?.path.node)) return false;
  const { imported } = binding.path.node;
  if (!t.isIdentifier(imported)) return false;
  if (imported.name !== macro) return false;
  return true;
};

const isMacro = (path: NodePath<t.CallExpression>, macro: string) => {
  if (!t.isIdentifier(path.node.callee)) return false;
  const binding = path.scope.getBinding(path.node.callee.name);

  if (!binding) return false;
  if (!isMacroBinding(binding, macro)) return false;

  if (path.node.arguments.length !== 1) {
    throw path.buildCodeFrameError(`'${macro}' must take exactly one argument`);
  }
  return true;
};

export function transformMacros(ast: Node, options: { ssr: boolean }) {
  traverse(ast, {
    CallExpression(path) {
      if (isMacro(path, options.ssr ? "clientOnly$" : "serverOnly$")) {
        path.replaceWith(t.identifier("undefined"));
      }
      if (isMacro(path, options.ssr ? "serverOnly$" : "clientOnly$")) {
        const arg = path.node.arguments[0];
        if (t.isExpression(arg)) {
          path.replaceWith(arg);
        }
      }
    },

    Identifier(path) {
      if (t.isImportSpecifier(path.parent)) return;

      const binding = path.scope.getBinding(path.node.name);
      if (!binding) return;
      if (!isMacroBinding(binding, "serverOnly$") && !isMacroBinding(binding, "clientOnly$")) {
        return;
      }
      if (t.isCallExpression(path.parent)) return;
      throw path.buildCodeFrameError(
        `'${path.node.name}' macro cannot be manipulated at runtime as it must be statically analysable`,
      );
    },

    ImportDeclaration(path) {
      if (path.node.source.value !== macrosSpecifier) return;
      path.node.specifiers.forEach((specifier, i) => {
        if (t.isImportNamespaceSpecifier(specifier)) {
          const subpath = path.get(`specifiers.${i}`);
          if (Array.isArray(subpath)) throw new Error("unreachable");
          throw subpath.buildCodeFrameError(
            `Namespace import is not supported by '${macrosSpecifier}'`,
          );
        }
      });
    },
  });
}
