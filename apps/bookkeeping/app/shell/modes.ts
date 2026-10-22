import type { OrganizationKind } from "../../workers/directory/directory";

/** What someone is doing in Bookkeeping: operating it, or working in a firm or for a client. */
export type Mode = "operator" | OrganizationKind;

/** Where someone can go in Bookkeeping, as `/start` and the switcher list it. */
export type Place = { mode: Mode; name: string; path: string };

/** Each mode's name, shown beside a place's name in the switcher. */
export const MODE_LABELS: Record<Mode, string> = {
  operator: "Operator",
  firm: "Firm",
  client: "Client",
};

/** `/start`'s group headings. */
export const MODE_GROUP_LABELS: Record<Mode, string> = {
  operator: "Operator",
  firm: "Firms",
  client: "Clients",
};

export const MODES: Mode[] = ["operator", "firm", "client"];
