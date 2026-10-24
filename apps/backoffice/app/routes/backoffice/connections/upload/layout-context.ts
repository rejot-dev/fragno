import type { Dispatch, SetStateAction } from "react";

import type { BackofficeMeData } from "@/fragno/auth/contracts";
import type { UploadAdminConfigResponse } from "@/fragno/upload";
import type { UploadReplicaSource } from "@/fragno/upload/lofi/replica";

type BackofficeOrganization = BackofficeMeData["organizations"][number]["organization"];

export type UploadLayoutContext = {
  origin: string;
  organization: BackofficeOrganization;
  configState: UploadAdminConfigResponse | null;
  configLoading: boolean;
  configError: string | null;
  persistenceSource: UploadReplicaSource | null;
  persistenceError: string | null;
  setConfigState: Dispatch<SetStateAction<UploadAdminConfigResponse | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type UploadTab = "files" | "configuration";
export type UploadConfigurableProvider = "database" | "r2-binding" | "r2";
