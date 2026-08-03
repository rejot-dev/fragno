import type { AuthMeData } from "@/fragno/auth/auth-client";

type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];

export type FilesLayoutContext = {
  orgId: string;
  origin: string;
  organisation: BackofficeOrganisation;
};
