import {
  type IssueBackofficeTokenInput,
  issueBackofficeTokenResultSchema,
  type IssueBackofficeTokenResult,
} from "./contracts";
import { readBackofficeSessionExchangeErrorMessage } from "./session-exchange-error";

export async function exchangeBackofficeSessionForJwt(
  input: IssueBackofficeTokenInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<IssueBackofficeTokenResult> {
  const response = await fetchImplementation("/api/auth/backoffice-token", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await readBackofficeSessionExchangeErrorMessage(response));
  }
  return issueBackofficeTokenResultSchema.parse(await response.json());
}
