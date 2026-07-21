const STREAM_OFFSET_REGEX = /^[0-9a-f]{25}$/;
const MAX_STREAM_OFFSET = 1n << 96n;

export const INITIAL_STREAM_OFFSET = "-1";

export function parseStreamOffset(value: unknown, path: string): string {
  if (value === INITIAL_STREAM_OFFSET) {
    return value;
  }
  if (typeof value !== "string" || !STREAM_OFFSET_REGEX.test(value)) {
    throw new Error(`${path} must be -1 or a 25-character lowercase hexadecimal offset.`);
  }
  if (BigInt(`0x${value}`) > MAX_STREAM_OFFSET) {
    throw new Error(`${path} is outside the Fragno Durable Streams offset range.`);
  }
  return value;
}

export function compareStreamOffsets(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left === INITIAL_STREAM_OFFSET) {
    return -1;
  }
  if (right === INITIAL_STREAM_OFFSET) {
    return 1;
  }
  return BigInt(`0x${left}`) < BigInt(`0x${right}`) ? -1 : 1;
}
