import type { BackofficeMeData } from "@/fragno/auth/contracts";
import type { UploadCollectionSource } from "@/fragno/upload/tanstack/browser-database";

type BackofficeOrganization = BackofficeMeData["organizations"][number]["organization"];

export type UploadLayoutContext = {
  origin: string;
  organization: BackofficeOrganization;
  persistenceSource: UploadCollectionSource | null;
  persistenceError: string | null;
};
