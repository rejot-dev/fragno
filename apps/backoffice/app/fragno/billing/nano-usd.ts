const NANO_USD_PER_USD = 1_000_000_000;

const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  // Single model calls cost fractions of a cent.
  maximumFractionDigits: 6,
});

/** Formats a quantity of the `nano-usd` unit, which cost meters record, as dollars. */
export function formatNanoUsd(quantity: string): string {
  return USD_FORMATTER.format(Number(BigInt(quantity)) / NANO_USD_PER_USD);
}
