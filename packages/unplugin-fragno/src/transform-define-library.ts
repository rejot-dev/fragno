import { traverse } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import type { Node } from "@babel/types";

const FRAGNO_PACKAGES = ["@fragno-dev/core"];

const isDefineLibraryBinding = (binding: Binding): boolean => {
  if (!t.isImportDeclaration(binding?.path.parent)) {
    return false;
  }

  const source = binding.path.parent.source.value;
  if (!FRAGNO_PACKAGES.some((pkg) => source.startsWith(pkg))) {
    return false;
  }

  if (!t.isImportSpecifier(binding?.path.node)) {
    return false;
  }

  const { imported } = binding.path.node;
  if (!t.isIdentifier(imported)) {
    return false;
  }

  if (imported.name !== "defineLibrary") {
    return false;
  }

  return true;
};

const isDefineLibraryCall = (node: t.CallExpression, scope: Scope): boolean => {
  if (!t.isIdentifier(node.callee)) {
    return false;
  }
  const binding = scope.getBinding(node.callee.name);

  if (!binding) {
    return false;
  }
  return isDefineLibraryBinding(binding);
};

const createNoOpArrowFunction = (): t.ArrowFunctionExpression => {
  return t.arrowFunctionExpression([], t.blockStatement([]));
};

const isDefineLibraryChain = (node: t.Node, scope: Scope): boolean => {
  // Check direct defineLibrary call
  if (t.isCallExpression(node) && isDefineLibraryCall(node, scope)) {
    return true;
  }

  // Check chained method calls
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
    return isDefineLibraryChain(node.callee.object, scope);
  }

  // Check if it's an identifier that refers to a defineLibrary result
  if (t.isIdentifier(node)) {
    const binding = scope.getBinding(node.name);
    if (binding && binding.path.isVariableDeclarator()) {
      const init = binding.path.node.init;
      if (init) {
        return isDefineLibraryChain(init, scope);
      }
    }
  }

  return false;
};

export function transformDefineLibrary(ast: Node, options: { ssr: boolean }): void {
  if (options.ssr) {
    return;
  }

  traverse(ast, {
    CallExpression(path) {
      const { callee } = path.node;

      // Check if this is a method call
      if (!t.isMemberExpression(callee)) {
        return;
      }

      const { property, object } = callee;

      // Check if the method is withDependencies or withServices
      if (!t.isIdentifier(property)) {
        return;
      }

      const methodName = property.name;
      if (methodName !== "withDependencies" && methodName !== "withServices") {
        return;
      }

      // Check if this is part of a defineLibrary chain
      if (!isDefineLibraryChain(object, path.scope)) {
        return;
      }

      // Replace the argument with a no-op function that returns this
      path.node.arguments = [createNoOpArrowFunction()];
    },
  });
}
