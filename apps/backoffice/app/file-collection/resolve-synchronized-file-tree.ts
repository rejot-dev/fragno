import type { FileTree } from "./file-collection";

export type SynchronizedFileTreeState =
  | { status: "loading" }
  | { status: "ready"; tree: FileTree }
  | { status: "error"; error: unknown };

export function resolveSynchronizedFileTree(
  initialTree: FileTree,
  state: SynchronizedFileTreeState,
): FileTree {
  return state.status === "ready" ? state.tree : initialTree;
}
