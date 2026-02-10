import { traverse } from "@babel/core";
import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Node } from "@babel/types";

const SYNC_COMMANDS_PACKAGES = ["@fragno-dev/db", "@fragno-dev/db/sync"];

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
