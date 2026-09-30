const CLOUDFLARE_SANDBOX_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

async function createCloudflareSandboxIdentityDigest(
  managerId: string,
  sandboxId: string,
): Promise<Uint8Array> {
  const identity = new TextEncoder().encode(`${managerId}\0${sandboxId}`);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", identity));
}

/** Creates a manager-scoped lowercase base32 Cloudflare sandbox physical ID. */
export async function createCloudflareSandboxPhysicalId(
  managerId: string,
  sandboxId: string,
): Promise<string> {
  const digest = await createCloudflareSandboxIdentityDigest(managerId, sandboxId);
  let encoded = "";
  let bits = 0;
  let value = 0;

  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += CLOUDFLARE_SANDBOX_ID_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    encoded += CLOUDFLARE_SANDBOX_ID_ALPHABET[(value << (5 - bits)) & 31];
  }
  return encoded;
}
