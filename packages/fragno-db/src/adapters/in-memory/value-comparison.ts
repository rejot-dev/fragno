const asBuffer = (value: unknown): Buffer | undefined => {
  if (value instanceof Buffer) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return undefined;
};

const compareByType = (left: unknown, right: unknown): number | undefined => {
  const leftBuffer = asBuffer(left);
  const rightBuffer = asBuffer(right);
  if (leftBuffer && rightBuffer) {
    return Buffer.compare(leftBuffer, rightBuffer);
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
  return undefined;
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
  const typed = compareByType(left, right);
  if (typed !== undefined) {
    return typed;
  }
  const leftString = String(left);
  const rightString = String(right);
  return leftString < rightString ? -1 : leftString > rightString ? 1 : 0;
};
