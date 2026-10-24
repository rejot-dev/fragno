// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/shared/src/binary-search.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
/**
 * This is a binary search that returns the index of the first element in the
 * array that is greater than or equal to the given value.
 *
 * Typical usage:
 *
 * ```
 * const haystack = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
 * const needle = 3;
 * const index = binarySearch(haystack.length, i => needle - haystack[i]);
 * const found = index < haystack.length && haystack[index] === needle;
 * ```
 */
export function binarySearch(high: number, compare: (i: number) => number) {
  let low = 0;
  while (low < high) {
    const mid = low + ((high - low) >> 1);
    const i = compare(mid);
    if (i === 0) {
      return mid;
    }
    if (i > 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}
