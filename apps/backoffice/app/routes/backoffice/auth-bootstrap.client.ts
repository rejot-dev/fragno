import { recordIssuedBackofficeToken } from "@/fragno/auth/browser-auth.client";
import { exchangeBackofficeSessionForJwt } from "@/fragno/auth/session-exchange.client";

export async function bootstrapBackofficePreferredOrganization(
  preferredOrganizationId: string | null,
  writePreference: (organizationId: string | null) => void,
  fetchImplementation: typeof fetch = fetch,
) {
  const result = await exchangeBackofficeSessionForJwt(
    { selection: "preferred", organizationId: preferredOrganizationId },
    fetchImplementation,
  );
  writePreference(result.organization?.id ?? null);
  recordIssuedBackofficeToken(result);
  return result;
}

export async function bootstrapBackofficeSession(
  organizationId: string,
  writePreference: (organizationId: string | null) => void,
  fetchImplementation: typeof fetch = fetch,
) {
  const result = await exchangeBackofficeSessionForJwt(
    { selection: "required", organizationId },
    fetchImplementation,
  );
  writePreference(result.organization?.id ?? null);
  recordIssuedBackofficeToken(result);
  return result;
}
