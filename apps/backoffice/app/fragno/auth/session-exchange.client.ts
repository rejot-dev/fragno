import { z } from "zod";

import {
  type IssueBackofficeTokenInput,
  issueBackofficeTokenResultSchema,
  type IssueBackofficeTokenResult,
} from "./contracts";
import { readBackofficeSessionExchangeErrorMessage } from "./session-exchange-error";

const organizationProvisioningResponseSchema = z.object({
  status: z.literal("organization_provisioning"),
  retryAfterMs: z.number().int().positive(),
});

export class BackofficeOrganizationProvisioningError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Your organisation is still being created.");
    this.name = "BackofficeOrganizationProvisioningError";
    this.retryAfterMs = retryAfterMs;
  }
}

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
  if (response.status === 202) {
    const provisioning = organizationProvisioningResponseSchema.parse(await response.json());
    throw new BackofficeOrganizationProvisioningError(provisioning.retryAfterMs);
  }
  if (!response.ok) {
    throw new BackofficeSessionExchangeError(
      response.status,
      await readBackofficeSessionExchangeErrorMessage(response),
    );
  }
  return issueBackofficeTokenResultSchema.parse(await response.json());
}

export async function waitForPreferredBackofficeSessionForJwt(
  preferredOrganizationId: string | null,
  fetchImplementation: typeof fetch = fetch,
  sleep: (durationMs: number) => Promise<void> = (durationMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, durationMs);
    }),
  timeoutMs = 15_000,
  now: () => number = Date.now,
): Promise<IssueBackofficeTokenResult> {
  const startedAt = now();
  while (true) {
    try {
      return await exchangeBackofficeSessionForJwt(
        { selection: "preferred", organizationId: preferredOrganizationId },
        fetchImplementation,
      );
    } catch (error) {
      if (!(error instanceof BackofficeOrganizationProvisioningError)) {
        throw error;
      }
      if (now() - startedAt + error.retryAfterMs > timeoutMs) {
        throw new Error(
          "Your organisation could not be created in time. Try again or sign out and retry.",
        );
      }
      await sleep(error.retryAfterMs);
    }
  }
}
