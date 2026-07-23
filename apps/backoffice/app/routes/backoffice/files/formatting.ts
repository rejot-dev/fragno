import type { FileMountMetadata } from "@/files";

export function formatFileRootKind(kind: FileMountMetadata["kind"]) {
  switch (kind) {
    case "static":
      return "Static";
    case "upload":
      return "Upload";
    case "custom":
      return "Custom";
  }

  throw new Error("Unsupported file mount kind.");
}

export function formatFileRootPersistence(persistence: FileMountMetadata["persistence"]) {
  switch (persistence) {
    case "ephemeral":
      return "Ephemeral";
    case "persistent":
      return "Persistent";
    case "session":
      return "Session";
  }

  throw new Error("Unsupported file mount persistence.");
}

export const formatFileRootMutability = (readOnly: boolean) =>
  readOnly ? "Read-only" : "Writable";
