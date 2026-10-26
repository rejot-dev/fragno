import { sanitizeBackofficeReturnTo } from "./auth-navigation";

/** Where a person who has not finished onboarding is sent, wherever in Backoffice they go. */
export const BACKOFFICE_ONBOARDING_PATH = "/backoffice/onboarding";
const RETURN_TO_PARAM = "returnTo";

/** Onboarding that continues to `returnTo` once it is complete. */
export function buildBackofficeOnboardingPath(returnTo: string): string {
  return `${BACKOFFICE_ONBOARDING_PATH}?${new URLSearchParams({ [RETURN_TO_PARAM]: returnTo })}`;
}

/** Where completed onboarding continues: a Backoffice page it was asked to return to, if any. */
export function onboardingReturnTo(url: URL): string | null {
  return sanitizeBackofficeReturnTo(url.searchParams.get(RETURN_TO_PARAM));
}

/**
 * Pages a person opens before onboarding: an invitation they accept first makes them a member, so
 * onboarding does not ask what they use Backoffice for.
 */
export function opensBeforeOnboarding(pathname: string): boolean {
  return pathname.startsWith("/backoffice/invitations/");
}
