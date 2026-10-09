import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";

export type FilesLayoutContext = {
  scope: BackofficeContextScope;
  selectedScope: BackofficeScopeSelection;
  origin: string;
};
