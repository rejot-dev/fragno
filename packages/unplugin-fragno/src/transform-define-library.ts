import { traverse } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import type { Node } from "@babel/types";

const FRAGNO_PACKAGE_DEFINITIONS = {
  "@fragno-dev/core": {
    fragmentDefinitions: ["defineFragment"],
    chainMethods: ["withDependencies", "withServices"],
  },
  "@fragno-dev/db": {
    fragmentDefinitions: ["defineFragmentWithDatabase"],
    chainMethods: ["withDependencies", "withServices", "withDatabase"],
    utilityFunctions: ["schema"],
  },
} as const;

type PackageDefinition =
  (typeof FRAGNO_PACKAGE_DEFINITIONS)[keyof typeof FRAGNO_PACKAGE_DEFINITIONS];

const getPackageDefinition = (source: string): PackageDefinition | undefined => {
  for (const [pkg, definition] of Object.entries(FRAGNO_PACKAGE_DEFINITIONS)) {
    if (source === pkg || source.startsWith(`${pkg}/`)) {
      return definition;
    }
  }
  return undefined;
};

const getAllChainMethods = (): Set<string> => {
  const methods = new Set<string>();
  for (const definition of Object.values(FRAGNO_PACKAGE_DEFINITIONS)) {
    if ("chainMethods" in definition) {
      for (const method of definition.chainMethods) {
        methods.add(method);
      }
    }
  }
  return methods;
};

const isDefineLibraryBinding = (binding: Binding): boolean => {
  if (!t.isImportDeclaration(binding?.path.parent)) {
    return false;
  }

  const source = binding.path.parent.source.value;
  const definition = getPackageDefinition(source);

  if (!definition || !("fragmentDefinitions" in definition)) {
    return false;
  }

  if (!t.isImportSpecifier(binding?.path.node)) {
    return false;
  }

  const { imported } = binding.path.node;
  if (!t.isIdentifier(imported)) {
    return false;
  }

  // Safe cast: we checked that fragmentDefinitions exists above
  if (!(definition.fragmentDefinitions as readonly string[]).includes(imported.name)) {
    return false;
  }

  return true;
};

const isUtilityFunctionBinding = (binding: Binding): boolean => {
  if (!t.isImportDeclaration(binding?.path.parent)) {
    return false;
  }

  const source = binding.path.parent.source.value;
  const definition = getPackageDefinition(source);

  if (!definition || !("utilityFunctions" in definition)) {
    return false;
  }

  if (!t.isImportSpecifier(binding?.path.node)) {
    return false;
  }

  const { imported } = binding.path.node;
  if (!t.isIdentifier(imported)) {
    return false;
  }

  // Safe cast: we checked that utilityFunctions exists above
  if (!(definition.utilityFunctions as readonly string[]).includes(imported.name)) {
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
  // Check direct defineFragment call
  if (t.isCallExpression(node) && isDefineLibraryCall(node, scope)) {
    return true;
  }

  // Check chained method calls
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
    return isDefineLibraryChain(node.callee.object, scope);
  }

  // Check if it's an identifier that refers to a defineFragment result
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

  const chainMethods = getAllChainMethods();

  traverse(ast, {
    CallExpression(path) {
      const { callee } = path.node;

      // Check if this is a utility function call (like schema)
      if (t.isIdentifier(callee)) {
        const binding = path.scope.getBinding(callee.name);
        if (binding && isUtilityFunctionBinding(binding)) {
          // Replace with a no-op function call
          path.node.arguments = [createNoOpArrowFunction()];
          return;
        }
      }

      // Check if this is a method call
      if (!t.isMemberExpression(callee)) {
        return;
      }

      const { property, object } = callee;

      // Check if the method is a chain method
      if (!t.isIdentifier(property)) {
        return;
      }

      const methodName = property.name;
      if (!chainMethods.has(methodName)) {
        return;
      }

      // Check if this is part of a defineFragment chain
      if (!isDefineLibraryChain(object, path.scope)) {
        return;
      }

      // Replace the argument with a no-op function
      path.node.arguments = [createNoOpArrowFunction()];
    },
  });
}
