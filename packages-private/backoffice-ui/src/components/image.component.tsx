import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useFileImage } from "../file-image";

export function Image({ props }: Parameters<ComponentFn<typeof backofficeUiCatalog, "Image">>[0]) {
  const FileImage = useFileImage();
  return <FileImage path={props.path} alt={props.alt} />;
}
