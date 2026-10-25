import type { PartyRole } from "@fragno-dev/ledger/schema";

/** Customers post to receivable control accounts, suppliers to payable ones. */
export const CONTROL_ROLES = {
  customer: "receivable",
  supplier: "payable",
} as const satisfies Record<PartyRole, string>;

/**
 * The control account a new customer or supplier posts to when none is chosen: the books' only
 * active one for the role, or null when there is none or a choice to make.
 */
export function usualControlAccount<TAccount extends { active: boolean; role: string }>(
  accounts: TAccount[],
  role: PartyRole,
): TAccount | null {
  const candidates = accounts.filter(
    (account) => account.active && account.role === CONTROL_ROLES[role],
  );
  return candidates.length === 1 ? candidates[0] : null;
}
