import type { UploadTab } from "./shared";

export const resolveUploadWorkspaceTab = (pathSegments: readonly string[]): UploadTab => {
  const uploadIndex = pathSegments.lastIndexOf("upload");
  const workspaceSegment = uploadIndex >= 0 ? pathSegments[uploadIndex + 2] : undefined;

  if (workspaceSegment === "uploads" || workspaceSegment === "files") {
    return "files";
  }

  return "configuration";
};
