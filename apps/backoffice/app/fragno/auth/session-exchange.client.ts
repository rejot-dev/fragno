import { z } from "zod";

import { issueBackofficeTokenResultSchema, type IssueBackofficeTokenResult } from "./contracts";

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

async function readSessionExchangeErrorMessage(response: Response): Promise<string> {
  const responseText = (await response.text()).trim();
  if (!responseText) {
    return "Unable to prepare the Backoffice session.";
  }
  try {
    const payload = JSON.parse(responseText) as { message?: unknown };
    return typeof payload.message === "string" ? payload.message : responseText;
  } catch {
    return responseText;
  }
}

export async function exchangeBackofficeSessionForJwt(
  organizationId: string | null,
  fetchImplementation: typeof fetch = fetch,
): Promise<IssueBackofficeTokenResult> {
  const response = await fetchImplementation("/api/auth/backoffice-token", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId }),
  });
  if (response.status === 202) {
    const provisioning = organizationProvisioningResponseSchema.parse(await response.json());
    throw new BackofficeOrganizationProvisioningError(provisioning.retryAfterMs);
  }
  if (!response.ok) {
    throw new BackofficeSessionExchangeError(
      response.status,
      await readSessionExchangeErrorMessage(response),
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
      return await exchangePreferredBackofficeSessionForJwt(
        preferredOrganizationId,
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

export async function exchangePreferredBackofficeSessionForJwt(
  preferredOrganizationId: string | null,
  fetchImplementation: typeof fetch = fetch,
): Promise<IssueBackofficeTokenResult> {
  try {
    return await exchangeBackofficeSessionForJwt(preferredOrganizationId, fetchImplementation);
  } catch (error) {
    if (
      !preferredOrganizationId ||
      !(error instanceof BackofficeSessionExchangeError) ||
      error.status !== 403
    ) {
      throw error;
    }
    return await exchangeBackofficeSessionForJwt(null, fetchImplementation);
  }
}
