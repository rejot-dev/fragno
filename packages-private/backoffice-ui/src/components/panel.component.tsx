import { Panel as PanelView, PanelFooter } from "@fragno-private/design-system/panel";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { ScopeLink } from "./scope-link";

export const Panel: ComponentFn<typeof backofficeUiCatalog, "Panel"> = ({ props, children }) => (
  <PanelView
    title={props.title}
    leading={null}
    footer={
      props.link ? (
        <PanelFooter>
          <ScopeLink
            to={props.link.to}
            label={props.link.label}
            className="font-semibold text-[var(--bo-accent-fg)] hover:underline"
          >
            {props.link.label}
          </ScopeLink>
        </PanelFooter>
      ) : null
    }
  >
    {children}
  </PanelView>
);
