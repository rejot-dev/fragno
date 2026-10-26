/** A browser file's name as a workspace key segment; browsers name files without directories. */
export function workspaceFileName(filename: string): string {
  // oxlint-disable-next-line no-control-regex -- control characters are what file keys reject.
  const name = filename.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim();
  return name === "" || name === "." || name === ".." ? "upload" : name;
}
