import { useState } from "react";

import { FileTreeExplorer, type FileTreeExplorerNode } from "./file-tree-explorer";

export default { title: "Navigation/File tree explorer" };

const NODES: readonly FileTreeExplorerNode[] = [
  {
    kind: "root",
    path: "/workspace",
    title: "Workspace",
    children: [
      {
        kind: "directory",
        path: "/workspace/automations/",
        title: "automations",
        children: [
          {
            kind: "file",
            path: "/workspace/automations/onboarding.ts",
            title: "onboarding.ts",
            children: [],
          },
          {
            kind: "file",
            path: "/workspace/automations/billing.ts",
            title: "billing.ts",
            children: [],
          },
        ],
      },
      { kind: "file", path: "/workspace/README.md", title: "README.md", children: [] },
    ],
  },
  {
    kind: "root",
    path: "/system",
    title: "System",
    children: [{ kind: "file", path: "/system/config.json", title: "config.json", children: [] }],
  },
];

export function Default() {
  const [selectedPath, setSelectedPath] = useState<string | null>(
    "/workspace/automations/onboarding.ts",
  );

  return (
    <div className="flex h-[32rem] w-72 flex-col bg-[var(--bo-sidebar-bg)] shadow-[0_0_0_1px_var(--bo-border)]">
      <FileTreeExplorer
        nodes={NODES}
        selectedPath={selectedPath}
        buildNodeTo={() => ""}
        onNodeSelect={(node) => {
          setSelectedPath(node.path);
        }}
        defaultCollapsedRootPaths={["/system"]}
        ariaLabel="Files"
        rootIcon="hard-drive"
      />
    </div>
  );
}
