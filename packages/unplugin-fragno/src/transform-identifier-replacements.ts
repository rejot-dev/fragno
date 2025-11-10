import { traverse } from "@babel/core";
import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Node } from "@babel/types";

type IdentifierReplacement = {
  source: { package: string; identifier: string; isType: boolean };
  target: { package: string; identifier: string; isType: boolean };
};

const IDENTIFIER_REPLACEMENTS: IdentifierReplacement[] = [
  {
    source: {
      package: "@fragno-dev/db",
      identifier: "defineFragmentWithDatabase",
      isType: false,
    },
    target: { package: "@fragno-dev/core", identifier: "defineFragment", isType: false },
  },
  {
    source: {
      package: "@fragno-dev/db",
      identifier: "FragnoPublicConfigWithDatabase",
      isType: true,
    },
    target: { package: "@fragno-dev/core", identifier: "FragnoPublicConfig", isType: true },
  },
];

/**
 * Ensures that the target identifier is imported in the AST.
 * Handles both type and value imports.
 */
const ensureIdentifierImport = (ast: Node, replacement: IdentifierReplacement): void => {
  let hasTargetImport = false;
  let foundTargetPackageImport = false;

  const newImportSpecifier = t.importSpecifier(
    t.identifier(replacement.target.identifier),
    t.identifier(replacement.target.identifier),
  );

  // Check if target identifier is already imported, and add it if not
  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      if (source.startsWith(replacement.target.package)) {
        foundTargetPackageImport = true;

        // For type imports, check both ImportDeclaration.importKind and ImportSpecifier.importKind
        const isTypeImport = path.node.importKind === "type";

        for (const specifier of path.node.specifiers) {
          if (
            t.isImportSpecifier(specifier) &&
            t.isIdentifier(specifier.imported) &&
            specifier.imported.name === replacement.target.identifier
          ) {
            // Check if the import type matches what we need
            const specifierIsType = specifier.importKind === "type" || isTypeImport;
            if (specifierIsType === replacement.target.isType) {
              hasTargetImport = true;
              return;
            }
          }
        }

        // If we found the target package import but not the identifier, add it
        if (!hasTargetImport) {
          // Only add to matching import type (type vs value)
          if (isTypeImport === replacement.target.isType) {
            path.node.specifiers.push(newImportSpecifier);
            hasTargetImport = true;
          }
        }
      }
    },
  });

  // If no matching import exists, create one
  if (!foundTargetPackageImport && !hasTargetImport) {
    const newImport = replacement.target.isType
      ? t.importDeclaration([newImportSpecifier], t.stringLiteral(replacement.target.package))
      : t.importDeclaration([newImportSpecifier], t.stringLiteral(replacement.target.package));

    // Set importKind for type imports
    if (replacement.target.isType) {
      newImport.importKind = "type";
    }

    // Add at the beginning of the file
    if (t.isProgram(ast)) {
      ast.body.unshift(newImport);
    } else if (t.isFile(ast)) {
      ast.program.body.unshift(newImport);
    }
  }
};

export function transformIdentifierReplacements(ast: Node, options: { ssr: boolean }): void {
  if (options.ssr) {
    return;
  }

  const usedReplacements = new Set<IdentifierReplacement>();
  const importsToReplace = new Map<
    string,
    { replacement: IdentifierReplacement; path: NodePath<t.ImportSpecifier> }
  >();

  // First pass: find imports that need to be replaced
  traverse(ast, {
    ImportSpecifier(path) {
      if (!t.isImportDeclaration(path.parent)) {
        return;
      }

      const source = path.parent.source.value;
      const { imported, local } = path.node;

      if (!t.isIdentifier(imported) || !t.isIdentifier(local)) {
        return;
      }

      // Check if this import matches any replacement source
      for (const replacement of IDENTIFIER_REPLACEMENTS) {
        if (
          (source === replacement.source.package ||
            source.startsWith(`${replacement.source.package}/`)) &&
          imported.name === replacement.source.identifier
        ) {
          importsToReplace.set(local.name, { replacement, path });
          usedReplacements.add(replacement);
          break;
        }
      }
    },
  });

  // Second pass: Use Babel's rename to rename all bindings
  for (const [localName, { replacement, path: importPath }] of importsToReplace) {
    const binding = importPath.scope.getBinding(localName);
    if (binding) {
      binding.scope.rename(localName, replacement.target.identifier);
    }
  }

  // Third pass: remove old import specifiers
  traverse(ast, {
    ImportDeclaration(path) {
      if (path.removed) {
        return;
      }

      const source = path.node.source.value;

      for (const replacement of usedReplacements) {
        if (
          source === replacement.source.package ||
          source.startsWith(`${replacement.source.package}/`)
        ) {
          // Remove specifiers that match the replacement source
          const newSpecifiers = path.node.specifiers.filter((specifier) => {
            if (t.isImportSpecifier(specifier) && t.isIdentifier(specifier.imported)) {
              return specifier.imported.name !== replacement.source.identifier;
            }
            return true;
          });

          // If no specifiers left, remove the entire import
          if (newSpecifiers.length === 0) {
            path.remove();
            return; // Exit early to avoid accessing removed path
          } else {
            path.node.specifiers = newSpecifiers;
          }
        }
      }
    },
  });

  // Fourth pass: ensure all used replacement targets are imported
  for (const replacement of usedReplacements) {
    ensureIdentifierImport(ast, replacement);
  }
}
