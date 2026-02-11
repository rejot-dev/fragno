import { traverse } from "@babel/core";
import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Node } from "@babel/types";

const FRAGNO_PACKAGES = ["@fragno-dev/core"];

const isAddRouteBinding = (binding: Binding): boolean => {
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

  if (imported.name !== "addRoute" && imported.name !== "defineRoute") {
    return false;
  }

  return true;
};

/**
 * Check if a binding is an import of defineRoutes from Fragno
 */
const isRouteBuilderBinding = (binding: Binding): boolean => {
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

  if (imported.name !== "defineRoutes") {
    return false;
  }

  return true;
};

/**
 * Check if a binding comes from a callback parameter that provides defineRoute
 * from a Fragno API (defineRoutes).
 * Example: defineRoutes(fragment).create(({ defineRoute }) => [...])
 */
const isDefineRouteFromCallbackParam = (
  binding: Binding,
  fragnoCallbacks: Set<NodePath<t.Function>>,
): boolean => {
  // Check if the binding kind is "param" (function parameter)
  if (binding.kind !== "param") {
    return false;
  }

  // For destructured parameters, the binding path node is the ObjectPattern
  const bindingPath = binding.path;
  if (!t.isObjectPattern(bindingPath.node)) {
    return false;
  }

  // Check if the ObjectPattern contains a property named "defineRoute"
  const properties = bindingPath.node.properties;
  let hasDefineRoute = false;
  for (const prop of properties) {
    if (t.isObjectProperty(prop)) {
      const key = prop.key;
      if (t.isIdentifier(key) && key.name === "defineRoute") {
        hasDefineRoute = true;
        break;
      }
    }
  }

  if (!hasDefineRoute) {
    return false;
  }

  // Find the function that contains this parameter
  const functionParent = bindingPath.getFunctionParent();
  if (!functionParent) {
    return false;
  }

  // Check if this function is in our set of Fragno callbacks
  return fragnoCallbacks.has(functionParent);
};

/**
 * Check if a member expression is accessing defineRoute from a callback parameter
 * from a Fragno API (defineRoutes).
 * Example: context.defineRoute(...)
 */
const isDefineRouteMemberAccess = (
  path: NodePath<t.CallExpression>,
  fragnoCallbacks: Set<NodePath<t.Function>>,
): boolean => {
  const { callee } = path.node;

  if (!t.isMemberExpression(callee)) {
    return false;
  }

  // Check if the property is "defineRoute"
  const property = callee.property;
  if (!t.isIdentifier(property) || property.name !== "defineRoute") {
    return false;
  }

  // Check if the object is an identifier that's a function parameter
  if (!t.isIdentifier(callee.object)) {
    return false;
  }

  const binding = path.scope.getBinding(callee.object.name);
  if (!binding || binding.kind !== "param") {
    return false;
  }

  // Find the function that contains this parameter
  const functionParent = path.getFunctionParent();
  if (!functionParent) {
    return false;
  }

  // Check if this function is in our set of Fragno callbacks
  return fragnoCallbacks.has(functionParent);
};

const isAddRouteCall = (
  path: NodePath<t.CallExpression>,
  fragnoCallbacks: Set<NodePath<t.Function>>,
): boolean => {
  // Case 1: Direct call - defineRoute(...)
  if (t.isIdentifier(path.node.callee)) {
    const binding = path.scope.getBinding(path.node.callee.name);

    if (!binding) {
      return false;
    }

    // Check if it's from an import or from a callback parameter
    return isAddRouteBinding(binding) || isDefineRouteFromCallbackParam(binding, fragnoCallbacks);
  }

  // Case 2: Member access - context.defineRoute(...)
  if (t.isMemberExpression(path.node.callee)) {
    return isDefineRouteMemberAccess(path, fragnoCallbacks);
  }

  return false;
};

function replaceHandlerWithNoop(routeConfig: t.Expression) {
  if (!t.isObjectExpression(routeConfig)) {
    return;
  }

  const handlerProp = routeConfig.properties.find((prop) => {
    if (t.isObjectProperty(prop) || t.isObjectMethod(prop)) {
      const key = prop.key;
      return t.isIdentifier(key) && key.name === "handler";
    }
    return false;
  });

  if (!handlerProp) {
    return;
  }

  if (t.isObjectProperty(handlerProp)) {
    handlerProp.value = t.arrowFunctionExpression([], t.blockStatement([]));
  } else if (t.isObjectMethod(handlerProp)) {
    handlerProp.body = t.blockStatement([]);
    handlerProp.params = [];
  }
}

/**
 * Collect all callback functions that are passed to .create() on Fragno route builders
 * (defineRoutes or defineRoutes)
 */
function collectFragnoCallbacks(ast: Node): Set<NodePath<t.Function>> {
  const fragnoCallbacks = new Set<NodePath<t.Function>>();

  traverse(ast, {
    CallExpression(path) {
      const { callee } = path.node;

      // Check for pattern: identifier.create(callback) or chainedCall().create(callback)
      if (!t.isMemberExpression(callee)) {
        return;
      }

      // Check if the property is "create"
      const property = callee.property;
      if (!t.isIdentifier(property) || property.name !== "create") {
        return;
      }

      // Try to resolve the object to a Fragno route builder
      let isFragnoBuilder = false;

      // Case 1: Direct identifier - defineRoutes.create() or defineRoutes.create()
      if (t.isIdentifier(callee.object)) {
        const binding = path.scope.getBinding(callee.object.name);
        if (binding && isRouteBuilderBinding(binding)) {
          isFragnoBuilder = true;
        }
      }

      // Case 2: Call expression - defineRoutes().create() or defineRoutes().create()
      if (t.isCallExpression(callee.object)) {
        const innerCallee = callee.object.callee;
        if (t.isIdentifier(innerCallee)) {
          const binding = path.scope.getBinding(innerCallee.name);
          if (binding && isRouteBuilderBinding(binding)) {
            isFragnoBuilder = true;
          }
        }
      }

      if (!isFragnoBuilder) {
        return;
      }

      // Extract the callback function argument
      if (path.node.arguments.length > 0) {
        const firstArg = path.node.arguments[0];
        // The callback can be an arrow function or a function expression
        if (t.isFunction(firstArg)) {
          const funcPath = path.get("arguments.0") as NodePath<t.Function>;
          fragnoCallbacks.add(funcPath);
        }
      }
    },
  });

  return fragnoCallbacks;
}

export function transformDefineRoute(ast: Node, options: { ssr: boolean }) {
  if (options.ssr) {
    return;
  }

  // First pass: collect all callbacks from Fragno route builders
  const fragnoCallbacks = collectFragnoCallbacks(ast);

  // Second pass: transform defineRoute calls
  traverse(ast, {
    CallExpression(path) {
      if (!isAddRouteCall(path, fragnoCallbacks)) {
        return;
      }

      if (path.node.arguments.length > 0) {
        const firstArg = path.node.arguments[0];
        if (t.isExpression(firstArg)) {
          replaceHandlerWithNoop(firstArg);
        }
      }
    },
  });
}
