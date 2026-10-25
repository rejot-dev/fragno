/**
 * Amounts are integers of a currency's minor units, as the ledger keeps them; people read and
 * write them as decimals.
 */

/** `amountMinor` as a decimal with the currency's digits and grouped thousands, e.g. `1,234.50`. */
export function formatAmount(amountMinor: bigint, minorUnitDigits: number): string {
  const [whole, fraction] = decimalAmount(amountMinor, minorUnitDigits).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+$)/gu, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** `amountMinor` as a plain decimal with the currency's digits, e.g. `1234.50`, as APIs pass it. */
export function decimalAmount(amountMinor: bigint, minorUnitDigits: number): string {
  const digits = (amountMinor < 0n ? -amountMinor : amountMinor)
    .toString()
    .padStart(minorUnitDigits + 1, "0");
  const whole = digits.slice(0, digits.length - minorUnitDigits);
  const fraction = digits.slice(digits.length - minorUnitDigits);
  return `${amountMinor < 0n ? "-" : ""}${whole}${minorUnitDigits > 0 ? `.${fraction}` : ""}`;
}

/**
 * The minor units of a positive decimal such as `1234.5` or `1234,50`, or null when the text is
 * not one or has more decimals than the currency. Thousands separators are not accepted, so a
 * comma can only be the decimal separator.
 */
export function parseAmount(text: string, minorUnitDigits: number): bigint | null {
  const match = /^(\d+)(?:[.,](\d+))?$/u.exec(text.trim());
  if (!match) {
    return null;
  }
  const [, whole, fraction = ""] = match;
  if (fraction.length > minorUnitDigits) {
    return null;
  }
  return BigInt(whole + fraction.padEnd(minorUnitDigits, "0"));
}
