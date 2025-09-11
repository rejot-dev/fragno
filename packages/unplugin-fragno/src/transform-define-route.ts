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

const isAddRouteCall = (path: NodePath<t.CallExpression>): boolean => {
  if (!t.isIdentifier(path.node.callee)) {
    return false;
  }
  const binding = path.scope.getBinding(path.node.callee.name);

  if (!binding) {
    return false;
  }

  return isAddRouteBinding(binding);
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

export function transformDefineRoute(ast: Node, options: { ssr: boolean }) {
  if (options.ssr) {
    return;
  }

  traverse(ast, {
    CallExpression(path) {
      if (!isAddRouteCall(path)) {
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
