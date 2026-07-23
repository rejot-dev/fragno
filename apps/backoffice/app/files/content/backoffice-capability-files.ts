import { backofficeCapabilities } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import type { FileContent } from "../interface";

const collectBackofficeCapabilityFiles = (): Record<string, FileContent> => {
  const files: Record<string, FileContent> = {};

  for (const capability of backofficeCapabilities) {
    for (const [path, content] of Object.entries(capability.files ?? {})) {
      if (Object.prototype.hasOwnProperty.call(files, path)) {
        throw new Error(`Duplicate Backoffice capability starter file: ${path}`);
      }
      files[path] = content;
    }
  }

  return files;
};

export const BACKOFFICE_CAPABILITY_FILE_CONTENT = collectBackofficeCapabilityFiles();
