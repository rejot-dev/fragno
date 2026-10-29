// Without 0/O and 1/I, so a code read aloud or retyped from a screenshot survives.
const ACCESS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ACCESS_CODE_LENGTH = 16;

/** The query parameter that carries an access code in a sign-up link. */
export const ACCESS_CODE_QUERY_PARAMETER = "code";

/** 16 characters of a 32-character alphabet: 80 random bits. */
export function generateAccessCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ACCESS_CODE_LENGTH));
  return Array.from(bytes, (byte) => ACCESS_CODE_ALPHABET[byte % ACCESS_CODE_ALPHABET.length]).join(
    "",
  );
}

/**
 * People type codes in any case and paste them with stray whitespace, and a label made into a
 * code keeps its words: "Launch 2026" and " launch  2026" are both LAUNCH-2026.
 */
export function normalizeAccessCode(code: string): string {
  return code.trim().replace(/\s+/gu, "-").toUpperCase();
}

export function buildAccessCodeSignUpUrl(publicBaseUrl: string, code: string): string {
  const url = new URL("/backoffice/sign-up", publicBaseUrl);
  url.searchParams.set(ACCESS_CODE_QUERY_PARAMETER, code);
  return url.toString();
}
