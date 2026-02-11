const toByteArray = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
};

const compareByteArrays = (left: Uint8Array, right: Uint8Array): number => {
  const minLength = Math.min(left.length, right.length);
  for (let i = 0; i < minLength; i += 1) {
    const diff = left[i]! - right[i]!;
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  if (left.length === right.length) {
    return 0;
  }
  return left.length < right.length ? -1 : 1;
};

export const compareNormalizedValues = (left: unknown, right: unknown): number => {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return -1;
  }
  if (right === undefined) {
    return 1;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  const leftBytes = toByteArray(left);
  const rightBytes = toByteArray(right);
  if (leftBytes && rightBytes) {
    return compareByteArrays(leftBytes, rightBytes);
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "bigint" && typeof right === "bigint") {
    return left < right ? -1 : 1;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : 1;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : left ? 1 : -1;
  }
  const leftString = String(left);
  const rightString = String(right);
  return leftString < rightString ? -1 : leftString > rightString ? 1 : 0;
};
