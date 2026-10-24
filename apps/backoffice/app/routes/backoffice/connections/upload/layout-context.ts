import type { BackofficeMeData } from "@/fragno/auth/contracts";
import type { UploadReplicaSource } from "@/fragno/upload/lofi/replica";

type BackofficeOrganization = BackofficeMeData["organizations"][number]["organization"];

export type UploadLayoutContext = {
  origin: string;
  organization: BackofficeOrganization;
  persistenceSource: UploadReplicaSource | null;
  persistenceError: string | null;
};
