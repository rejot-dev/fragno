import {
  type IssueBackofficeTokenInput,
  issueBackofficeTokenResultSchema,
  type IssueBackofficeTokenResult,
} from "./contracts";
import { readBackofficeSessionExchangeErrorMessage } from "./session-exchange-error";

export class BackofficeSessionExchangeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "BackofficeSessionExchangeError";
    this.status = status;
  }
}

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
    throw new BackofficeSessionExchangeError(
      response.status,
      await readBackofficeSessionExchangeErrorMessage(response),
    );
  }
  return issueBackofficeTokenResultSchema.parse(await response.json());
}
