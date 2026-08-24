import { recordIssuedBackofficeToken } from "@/fragno/auth/browser-auth.client";
import {
  exchangeBackofficeSessionForJwt,
  waitForPreferredBackofficeSessionForJwt,
} from "@/fragno/auth/session-exchange.client";

export async function bootstrapBackofficePreferredOrganization(
  preferredOrganizationId: string | null,
  writePreference: (organizationId: string | null) => void,
  fetchImplementation: typeof fetch = fetch,
) {
  const result = await waitForPreferredBackofficeSessionForJwt(
    preferredOrganizationId,
    fetchImplementation,
  );
  writePreference(result.organizationId);
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
  writePreference(result.organizationId);
  recordIssuedBackofficeToken(result);
  return result;
}
