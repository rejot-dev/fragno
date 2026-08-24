import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";

export type FilesLayoutContext = {
  scope: BackofficeContextScope;
  selectedScope: BackofficeScopeSelection;
  origin: string;
};
