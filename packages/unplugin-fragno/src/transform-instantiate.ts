import { traverse } from "@babel/core";
import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Node } from "@babel/types";

/**
 * Packages where instantiation functions are exported from
 */
const FRAGNO_PACKAGES = ["@fragno-dev/core"];

/**
 * Instantiation functions that should be replaced with empty objects in browser builds
 */
const INSTANTIATION_FUNCTIONS = ["instantiate", "instantiateFragment"];

/**
 * Check if a binding is from an instantiation function (instantiate or instantiateFragment)
 */
const isInstantiationBinding = (binding: Binding): boolean => {
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

  if (!INSTANTIATION_FUNCTIONS.includes(imported.name)) {
    return false;
  }

  return true;
};

/**
 * Find the root instantiation call in a chain and replace it with an empty object
 */
const replaceInstantiationChainWithEmptyObject = (path: NodePath<t.CallExpression>): void => {
  // Walk up to find the topmost call expression in the chain
  let current: NodePath = path;
  let topmost: NodePath<t.CallExpression> = path;

  while (current.parentPath) {
    const parent = current.parentPath;

    // If parent is a member expression, keep going up
    if (t.isMemberExpression(parent.node)) {
      const grandparent = parent.parentPath;
      if (grandparent && t.isCallExpression(grandparent.node)) {
        topmost = grandparent as NodePath<t.CallExpression>;
        current = grandparent;
        continue;
      }
    }
    break;
  }

  // Replace the topmost call with an empty object
  topmost.replaceWith(t.objectExpression([]));
};

export function transformInstantiate(ast: Node, options: { ssr: boolean }): void {
  if (options.ssr) {
    return;
  }

  // Collect all instantiation call expressions first
  const instantiationCalls: NodePath<t.CallExpression>[] = [];

  traverse(ast, {
    CallExpression(path) {
      const { callee } = path.node;

      // Check for direct call: instantiate(...) or instantiateFragment(...)
      if (t.isIdentifier(callee)) {
        const binding = path.scope.getBinding(callee.name);
        if (binding && isInstantiationBinding(binding)) {
          instantiationCalls.push(path);
        }
      }
    },
  });

  // Replace each instantiation chain with an empty object
  // We do this in a second pass to avoid issues with traversal during replacement
  for (const call of instantiationCalls) {
    if (call.node) {
      // Check if this call is still valid (hasn't been removed by a previous replacement)
      replaceInstantiationChainWithEmptyObject(call);
    }
  }
}
