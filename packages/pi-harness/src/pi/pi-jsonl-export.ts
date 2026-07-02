import { uuidv7, type SessionStorage } from "@earendil-works/pi-agent-core";

export const PI_JSONL_EXPORT_CWD = "/workspace";

export type ExportSessionStorageToJsonlOptions = {
  cwd: string;
  parentSessionPath?: string;
};

const leafIdAfterEntry = (entry: Awaited<ReturnType<SessionStorage["getEntries"]>>[number]) =>
  entry.type === "leaf" ? entry.targetId : entry.id;

export async function exportSessionStorageToJsonl(
  storage: SessionStorage,
  options: ExportSessionStorageToJsonlOptions,
): Promise<string> {
  const metadata = await storage.getMetadata();
  const entries = await storage.getEntries();

  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: metadata.id,
      timestamp: metadata.createdAt,
      cwd: options.cwd,
      parentSession: options.parentSessionPath,
    }),
  ];

  for (const entry of entries) {
    lines.push(JSON.stringify(entry));
  }

  // Preserve current leaf if the append log does not already end at it.
  const leafId = await storage.getLeafId();
  const last = entries[entries.length - 1];
  const lastLeaf = last ? leafIdAfterEntry(last) : null;

  if (leafId !== lastLeaf) {
    lines.push(
      JSON.stringify({
        type: "leaf",
        id: uuidv7(),
        parentId: lastLeaf,
        timestamp: new Date().toISOString(),
        targetId: leafId,
      }),
    );
  }

  return `${lines.join("\n")}\n`;
}
