import type { BackofficeContextScope } from "@/backoffice-runtime/context";

import type { FilesUiScope } from "./scope";

export type FilesLayoutContext = {
  scope: BackofficeContextScope;
  selectedScope: FilesUiScope;
  origin: string;
};
