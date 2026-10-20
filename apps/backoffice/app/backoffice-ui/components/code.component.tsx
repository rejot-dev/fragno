import { CodeBlock } from "@fragno-private/design-system/code-block";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Code: ComponentFn<typeof backofficeUiCatalog, "Code"> = ({ props }) => (
  <CodeBlock code={props.code} label={props.label} language={props.language} />
);
