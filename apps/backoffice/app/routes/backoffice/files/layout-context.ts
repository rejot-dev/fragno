import type { FileMountMetadata } from "@/files";
import type { AuthMeData } from "@/fragno/auth/auth-client";
import type { UploadCollectionSource } from "@/fragno/upload/tanstack/browser-database";

type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];

export type FilesLayoutContext = {
  orgId: string;
  origin: string;
  organisation: BackofficeOrganisation;
  mounts: FileMountMetadata[];
  uploadCollectionSource: UploadCollectionSource | null;
  uploadCollectionError: string | null;
};
