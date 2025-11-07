import { traverse } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import type { Node } from "@babel/types";

const FRAGNO_PACKAGE_DEFINITIONS = {
  "@fragno-dev/core": {
    fragmentDefinitions: ["defineFragment"],
    chainMethods: ["withDependencies", "providesService"],
  },
  "@fragno-dev/db": {
    fragmentDefinitions: ["defineFragmentWithDatabase"],
    chainMethods: ["withDependencies", "providesService", "withDatabase"],
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
    // After transformation, we might have created a defineFragment identifier
    // that doesn't have a binding yet. Check by name as a fallback.
    return node.callee.name === "defineFragment";
  }

  return isDefineLibraryBinding(binding) || isDefineFragmentWithDatabaseBinding(binding);
};

const createNoOpArrowFunction = (): t.ArrowFunctionExpression => {
  return t.arrowFunctionExpression([], t.blockStatement([]));
};

/**
 * Create an arrow function that returns its first parameter.
 * Used for utility functions like schema() where the callback needs to return a builder.
 */
const createPassThroughArrowFunction = (): t.ArrowFunctionExpression => {
  const param = t.identifier("s");
  return t.arrowFunctionExpression([param], param);
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

/**
 * Ensures that 'defineFragment' from '@fragno-dev/core' is imported in the AST.
 * If it's not imported, adds the import statement.
 */
const ensureDefineFragmentImport = (ast: Node): void => {
  let hasDefineFragmentImport = false;
  let foundCoreImport = false;

  const newImportSpecifier = t.importSpecifier(
    t.identifier("defineFragment"),
    t.identifier("defineFragment"),
  );

  // Check if defineFragment is already imported, and add it if not
  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      if (source === "@fragno-dev/core" || source.startsWith("@fragno-dev/core/")) {
        foundCoreImport = true;
        for (const specifier of path.node.specifiers) {
          if (
            t.isImportSpecifier(specifier) &&
            t.isIdentifier(specifier.imported) &&
            specifier.imported.name === "defineFragment"
          ) {
            hasDefineFragmentImport = true;
            return;
          }
        }

        // If we found the core import but not defineFragment, add it
        if (!hasDefineFragmentImport) {
          path.node.specifiers.push(newImportSpecifier);
          hasDefineFragmentImport = true;
        }
      }
    },
  });

  // If no @fragno-dev/core import exists, create one
  if (!foundCoreImport && !hasDefineFragmentImport) {
    const newImport = t.importDeclaration(
      [newImportSpecifier],
      t.stringLiteral("@fragno-dev/core"),
    );

    // Add at the beginning of the file
    if (t.isProgram(ast)) {
      ast.body.unshift(newImport);
    } else if (t.isFile(ast)) {
      ast.program.body.unshift(newImport);
    }
  }
};

const isDefineFragmentWithDatabaseBinding = (binding: Binding): boolean => {
  if (!t.isImportDeclaration(binding?.path.parent)) {
    return false;
  }

  const source = binding.path.parent.source.value;
  if (source !== "@fragno-dev/db" && !source.startsWith("@fragno-dev/db/")) {
    return false;
  }

  if (!t.isImportSpecifier(binding?.path.node)) {
    return false;
  }

  const { imported } = binding.path.node;
  if (!t.isIdentifier(imported)) {
    return false;
  }

  return imported.name === "defineFragmentWithDatabase";
};

export function transformDefineLibrary(ast: Node, options: { ssr: boolean }): void {
  if (options.ssr) {
    return;
  }

  const chainMethods = getAllChainMethods();
  let needsDefineFragmentImport = false;

  traverse(ast, {
    CallExpression(path) {
      const { callee } = path.node;

      // Check if this is a utility function call (like schema)
      if (t.isIdentifier(callee)) {
        const binding = path.scope.getBinding(callee.name);
        if (binding && isUtilityFunctionBinding(binding)) {
          // Replace with a pass-through function that returns its parameter
          // This prevents errors like "Cannot read properties of undefined (reading 'build')"
          // when schema(() => {}) would return undefined
          path.node.arguments = [createPassThroughArrowFunction()];
          return;
        }

        // Check if this is a defineFragmentWithDatabase call
        if (binding && isDefineFragmentWithDatabaseBinding(binding)) {
          // Replace with defineFragment
          path.node.callee = t.identifier("defineFragment");
          needsDefineFragmentImport = true;
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

      // Check if this is a withDatabase call - remove it entirely
      if (methodName === "withDatabase" && isDefineLibraryChain(object, path.scope)) {
        // Replace the entire call expression with just the object (removes .withDatabase(...))
        path.replaceWith(object);
        return;
      }

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

  // Add defineFragment import if needed
  if (needsDefineFragmentImport) {
    ensureDefineFragmentImport(ast);
  }
}
