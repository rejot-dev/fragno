import { traverse } from "@babel/core";
import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Node } from "@babel/types";

/**
 * Packages where the new fragment builder API is exported from
 */
const FRAGNO_PACKAGES = ["@fragno-dev/core"];

/**
 * Methods that should have their callback arguments stripped in browser builds
 */
const BUILDER_METHODS_WITH_CALLBACKS = [
  "withDependencies",
  "providesBaseService",
  "providesService",
  "withRequestStorage",
  "withExternalRequestStorage",
  "withRequestThisContext",
  "extend",
];

/**
 * Check if a binding is from defineFragment
 */
const isDefineFragmentBinding = (binding: Binding): boolean => {
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

  if (imported.name !== "defineFragment") {
    return false;
  }

  return true;
};

/**
 * Check if a member expression is a builder method call
 */
const isBuilderMethodCall = (
  path: NodePath<t.CallExpression>,
): { methodName: string; isChainedFromDefineFragment: boolean } | null => {
  if (!t.isMemberExpression(path.node.callee)) {
    return null;
  }

  const { property } = path.node.callee;
  if (!t.isIdentifier(property)) {
    return null;
  }

  const methodName = property.name;
  if (!BUILDER_METHODS_WITH_CALLBACKS.includes(methodName)) {
    return null;
  }

  // Check if this is part of a chain that starts with defineFragment
  // We'll do a simple check: walk up the call chain to see if we find defineFragment
  const isChainedFromDefineFragment = isChainedFromDefineFragmentCall(path);

  return { methodName, isChainedFromDefineFragment };
};

/**
 * Walk up a chain of member expressions to see if it starts with defineFragment
 */
const isChainedFromDefineFragmentCall = (path: NodePath<t.CallExpression>): boolean => {
  let current: t.Node | null = path.node;

  // Walk up the chain of calls
  while (current) {
    if (t.isCallExpression(current)) {
      // Check if this is a defineFragment call
      if (t.isIdentifier(current.callee)) {
        const binding = path.scope.getBinding(current.callee.name);
        if (binding && isDefineFragmentBinding(binding)) {
          return true;
        }
        return false;
      }

      // Continue walking up if it's a member expression
      if (t.isMemberExpression(current.callee)) {
        current = current.callee.object;
        continue;
      }

      return false;
    } else if (t.isMemberExpression(current)) {
      current = current.object;
    } else {
      return false;
    }
  }

  return false;
};

/**
 * Strip callback arguments from builder methods
 */
const stripCallbackArguments = (path: NodePath<t.CallExpression>, methodName: string): void => {
  // For providesService, keep the first argument (service name), remove the second (callback)
  if (methodName === "providesService") {
    if (path.node.arguments.length >= 1) {
      // Keep only the first argument
      const firstArg = path.node.arguments[0];
      if (firstArg && t.isExpression(firstArg)) {
        path.node.arguments = [firstArg];
      }
    }
  } else {
    // For all other methods, remove all arguments
    path.node.arguments = [];
  }
};

export function transformFragmentBuilder(ast: Node, options: { ssr: boolean }): void {
  if (options.ssr) {
    return;
  }

  traverse(ast, {
    CallExpression(path) {
      // Check if this is a builder method call
      const builderMethod = isBuilderMethodCall(path);
      if (builderMethod && builderMethod.isChainedFromDefineFragment) {
        stripCallbackArguments(path, builderMethod.methodName);
      }
    },
  });
}
