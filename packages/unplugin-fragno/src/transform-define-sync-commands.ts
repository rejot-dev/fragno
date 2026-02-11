import { traverse } from "@babel/core";
import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { ImportSpecifier, Node } from "@babel/types";

const SYNC_COMMANDS_PACKAGES = ["@fragno-dev/db", "@fragno-dev/db/sync"];
const SYNC_COMMANDS_SOURCE = "@fragno-dev/db/sync";
const DB_SOURCE = "@fragno-dev/db";

const isValueImportSpecifier = (specifier: t.ImportSpecifier, parent: t.ImportDeclaration) => {
  if (parent.importKind === "type") {
    return false;
  }
  return specifier.importKind !== "type";
};

const rewriteDefineSyncCommandsImport = (ast: Node): void => {
  let syncImportNode: unknown = null;
  const movedSpecifiers: ImportSpecifier[] = [];

  traverse(ast, {
    ImportDeclaration(path) {
      if (path.node.source.value === SYNC_COMMANDS_SOURCE) {
        if (path.node.importKind !== "type") {
          syncImportNode = path.node;
        }
        return;
      }

      if (path.node.source.value !== DB_SOURCE) {
        return;
      }

      const remaining: typeof path.node.specifiers = [];
      for (const specifier of path.node.specifiers) {
        if (
          t.isImportSpecifier(specifier) &&
          t.isIdentifier(specifier.imported) &&
          specifier.imported.name === "defineSyncCommands" &&
          isValueImportSpecifier(specifier, path.node)
        ) {
          movedSpecifiers.push(specifier);
          continue;
        }
        remaining.push(specifier);
      }

      if (remaining.length === 0) {
        path.remove();
        return;
      }

      path.node.specifiers = remaining;
    },
  });

  if (movedSpecifiers.length === 0) {
    return;
  }

  const syncImportNodeValue = syncImportNode as t.ImportDeclaration | null;

  if (syncImportNodeValue && syncImportNodeValue.importKind !== "type") {
    const existingLocals = new Set<string>();
    for (const specifier of syncImportNodeValue.specifiers) {
      if (t.isImportSpecifier(specifier)) {
        existingLocals.add(specifier.local.name);
      }
    }

    for (const specifier of movedSpecifiers) {
      if (!existingLocals.has(specifier.local.name)) {
        syncImportNodeValue.specifiers.push(specifier);
      }
    }
    return;
  }

  const newImport = t.importDeclaration(movedSpecifiers, t.stringLiteral(SYNC_COMMANDS_SOURCE));

  if (t.isProgram(ast)) {
    ast.body.unshift(newImport);
  } else if (t.isFile(ast)) {
    ast.program.body.unshift(newImport);
  }
};

const isDefineSyncCommandsBinding = (binding: Binding): boolean => {
  if (!t.isImportDeclaration(binding?.path.parent)) {
    return false;
  }

  const source = binding.path.parent.source.value;
  if (!SYNC_COMMANDS_PACKAGES.some((pkg) => source === pkg || source.startsWith(`${pkg}/`))) {
    return false;
  }

  if (!t.isImportSpecifier(binding?.path.node)) {
    return false;
  }

  const { imported } = binding.path.node;
  if (!t.isIdentifier(imported)) {
    return false;
  }

  return imported.name === "defineSyncCommands";
};

const isWithSyncCommandsCall = (path: NodePath<t.CallExpression>): boolean => {
  const { callee } = path.node;
  if (!t.isMemberExpression(callee)) {
    return false;
  }

  return t.isIdentifier(callee.property) && callee.property.name === "withSyncCommands";
};

export function transformDefineSyncCommands(ast: Node, options: { ssr: boolean }): void {
  if (options.ssr) {
    return;
  }

  rewriteDefineSyncCommandsImport(ast);

  traverse(ast, {
    CallExpression(path) {
      if (!t.isMemberExpression(path.node.callee)) {
        return;
      }

      const { object, property } = path.node.callee;
      if (!t.isIdentifier(property, { name: "create" })) {
        return;
      }

      if (!t.isCallExpression(object)) {
        return;
      }

      if (!t.isIdentifier(object.callee)) {
        return;
      }

      const binding = path.scope.getBinding(object.callee.name);
      if (!binding || !isDefineSyncCommandsBinding(binding)) {
        return;
      }

      const parentCall = path.parentPath;
      if (!parentCall?.isCallExpression() || !isWithSyncCommandsCall(parentCall)) {
        return;
      }

      const args = parentCall.get("arguments");
      const isArgument = args.some((arg) => !Array.isArray(arg) && arg.node === path.node);
      if (!isArgument) {
        return;
      }

      const statementParent = parentCall.getStatementParent();
      if (!statementParent) {
        return;
      }

      statementParent.insertBefore(t.expressionStatement(t.cloneNode(path.node, true)));
    },
  });
}
