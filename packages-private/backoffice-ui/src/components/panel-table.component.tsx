import {
  PanelFooter,
  PanelTable as PanelTableView,
  PanelTableRow as PanelTableRowView,
  panelRowTitleClassName,
  type PanelTableColumn,
} from "@fragno-private/design-system/panel";
import { Children, createContext, useContext, type ReactNode } from "react";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import type { BackofficeUiLinkTarget } from "./link";
import { ScopeLink } from "./scope-link";

const ColumnsContext = createContext<readonly PanelTableColumn[]>([]);

function Footer({ link }: { link: { label: string; to: BackofficeUiLinkTarget } | undefined }) {
  return link ? (
    <PanelFooter>
      <ScopeLink
        to={link.to}
        label={link.label}
        className="font-semibold text-[var(--bo-accent-fg)] hover:underline"
      >
        {link.label}
      </ScopeLink>
    </PanelFooter>
  ) : null;
}

export const PanelTable: ComponentFn<typeof backofficeUiCatalog, "PanelTable"> = ({
  props,
  children,
}) => {
  const columns = props.columns.map(({ label, align }) => ({ label, align: align ?? "start" }));
  return (
    <ColumnsContext value={columns}>
      <PanelTableView
        title={props.title}
        columns={columns}
        empty={props.empty}
        footer={<Footer link={props.link} />}
      >
        {children}
      </PanelTableView>
    </ColumnsContext>
  );
};

export const PanelTableRow: ComponentFn<typeof backofficeUiCatalog, "PanelTableRow"> = ({
  props,
  children,
}) => {
  const columns = useContext(ColumnsContext);
  const title: ReactNode = props.to ? (
    <ScopeLink to={props.to} label={props.title} className={panelRowTitleClassName}>
      {props.title}
    </ScopeLink>
  ) : (
    <span className={panelRowTitleClassName}>{props.title}</span>
  );
  return <PanelTableRowView title={title} columns={columns} cells={Children.toArray(children)} />;
};
