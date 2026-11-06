// No `+`: the fragment reads `local+token@domain` as a thread reply address.
const localPartPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Whoever receives these can act for the domain. Certificate authorities send domain validation to
// the first five (CA/Browser Forum Baseline Requirements 3.2.2.4.4); RFC 2142 names the rest as
// where operators receive abuse reports, security reports, and delivery failures.
const reservedLocalParts = new Set([
  "admin",
  "administrator",
  "hostmaster",
  "postmaster",
  "webmaster",
  "abuse",
  "security",
  "noc",
  "mailer-daemon",
  "root",
]);

export type ParsedMailboxAddress = { ok: true; address: string } | { ok: false; message: string };

/** Lowercased, as addresses are stored and matched. */
export function normalizeMailboxAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Whether an address may be registered: a valid mailbox whose local part no domain role needs. */
export function parseMailboxAddress(input: string): ParsedMailboxAddress {
  const address = normalizeMailboxAddress(input);
  const at = address.lastIndexOf("@");
  const localPart = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (at <= 0 || !domainPattern.test(domain)) {
    return { ok: false, message: "A mailbox address must look like name@example.com." };
  }
  if (!localPartPattern.test(localPart) || localPart.includes("..")) {
    return {
      ok: false,
      message:
        "Mailbox address names may use letters, digits, '.', '_', and '-', and must start and end with a letter or digit.",
    };
  }
  if (reservedLocalParts.has(localPart)) {
    return { ok: false, message: `${localPart}@ is reserved for the domain's operator.` };
  }
  return { ok: true, address };
}
