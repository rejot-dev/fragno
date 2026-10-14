import type { ComponentFn } from "@json-render/react";

import { FileImage } from "@/components/backoffice/file-image";

import type { backofficeUiCatalog } from "../catalog";

export function Image({ props }: Parameters<ComponentFn<typeof backofficeUiCatalog, "Image">>[0]) {
  return <FileImage path={props.path} alt={props.alt} />;
}
