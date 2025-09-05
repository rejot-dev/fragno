import { traverse } from "@babel/core";
import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Node } from "@babel/types";

const FRAGNO_PACKAGES = ["@fragno-dev/core"];

const isCreateLibraryBinding = (binding: Binding): boolean => {
  if (!t.isImportDeclaration(binding?.path.parent)) {
    return false;
  }

  const source = binding.path.parent.source.value;
  if (!FRAGNO_PACKAGES.includes(source)) {
    return false;
  }

  if (!t.isImportSpecifier(binding?.path.node)) {
    return false;
  }

  const { imported } = binding.path.node;
  if (!t.isIdentifier(imported)) {
    return false;
  }

  if (imported.name !== "createLibrary") {
    return false;
  }

  return true;
};

const isCreateLibraryCall = (path: NodePath<t.CallExpression>): boolean => {
  if (!t.isIdentifier(path.node.callee)) {
    return false;
  }
  const binding = path.scope.getBinding(path.node.callee.name);

  if (!binding) {
    return false;
  }
  return isCreateLibraryBinding(binding);
};

export function transformCreateLibrary(ast: Node, options: { ssr: boolean }): void {
  if (options.ssr) {
    return;
  }

  traverse(ast, {
    CallExpression(path) {
      if (!isCreateLibraryCall(path)) {
        return;
      }

      if (path.node.arguments.length >= 3) {
        path.node.arguments[2] = t.identifier("undefined");
      }
    },
  });
}
