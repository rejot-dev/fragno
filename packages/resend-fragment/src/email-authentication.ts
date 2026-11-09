import { z } from "zod";

/**
 * One check's result. `gray` is neither pass nor fail: SPF `none`, `softfail` or `neutral`; DKIM
 * unsigned or signed by a domain other than the From domain; DMARC passed without an enforcing
 * policy (none, or `p=none`).
 */
export const resendEmailAuthenticationResultSchema = z.enum([
  "pass",
  "fail",
  "gray",
  "processing_failed",
  "unknown",
]);

/**
 * The SPF, DKIM and DMARC results Resend's receiving server computed for a received email. They
 * come from that server, not from the message's headers, so a sender cannot forge them.
 */
export const resendEmailAuthenticationSchema = z.object({
  spf: resendEmailAuthenticationResultSchema,
  dkim: resendEmailAuthenticationResultSchema,
  dmarc: resendEmailAuthenticationResultSchema,
});

export type ResendEmailAuthenticationResult = z.infer<typeof resendEmailAuthenticationResultSchema>;
export type ResendEmailAuthentication = z.infer<typeof resendEmailAuthenticationSchema>;

const readResult = (value: unknown): ResendEmailAuthenticationResult => {
  const parsed = resendEmailAuthenticationResultSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
};

/**
 * Reads a received email's `authentication`, which the Resend SDK does not type. Null when Resend
 * sent none, as for email received before it introduced the field; a result Resend adds later
 * reads as `unknown`, never as a pass.
 */
export const readEmailAuthentication = (value: unknown): ResendEmailAuthentication | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { spf, dkim, dmarc } = value as Record<string, unknown>;
  return { spf: readResult(spf), dkim: readResult(dkim), dmarc: readResult(dmarc) };
};

/**
 * Whether the From domain sent the email. Resend's DKIM passes only for a signature by the From
 * domain, and DMARC only for an aligned pass under an enforcing policy; SPF alone checks the
 * envelope sender, which forwarding replaces.
 */
export const isSenderVerified = (authentication: ResendEmailAuthentication | null): boolean =>
  authentication?.dkim === "pass" || authentication?.dmarc === "pass";
