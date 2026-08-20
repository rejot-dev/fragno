import type { Dispatch, SetStateAction } from "react";

import type { BackofficeMeData } from "@/fragno/auth/auth-client";
import type { UploadAdminConfigResponse } from "@/fragno/upload";
import type { UploadCollectionSource } from "@/fragno/upload/tanstack/browser-database";

type BackofficeOrganisation = BackofficeMeData["organizations"][number]["organization"];

export type UploadLayoutContext = {
  orgId: string;
  origin: string;
  organisation: BackofficeOrganisation;
  configState: UploadAdminConfigResponse | null;
  configLoading: boolean;
  configError: string | null;
  persistenceSource: UploadCollectionSource | null;
  persistenceError: string | null;
  setConfigState: Dispatch<SetStateAction<UploadAdminConfigResponse | null>>;
  setConfigError: Dispatch<SetStateAction<string | null>>;
};

export type UploadTab = "files" | "configuration";
export type UploadConfigurableProvider = "database" | "r2-binding" | "r2";
