/**
 * An IBAN as banks print and people type it, e.g. `NL91 ABNA 0417 1643 00`, in its electronic
 * form, `NL91ABNA0417164300`; or null when it is not one, by its format and check digits.
 */
export function parseIban(text: string): string | null {
  const iban = text.replace(/\s+/gu, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(iban)) {
    return null;
  }
  // ISO 13616: moved to the end, with letters as numbers from 10, the whole is 1 modulo 97.
  // Validated above: letters and digits only.
  const digits = `${iban.slice(4)}${iban.slice(0, 4)}`
    .split("")
    .map((character) => Number.parseInt(character, 36).toString())
    .join("");
  let remainder = 0;
  for (const digit of digits) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1 ? iban : null;
}

/** An IBAN in groups of four, as people read it. */
export function formatIban(iban: string): string {
  return iban.replace(/(.{4})(?=.)/gu, "$1 ");
}
