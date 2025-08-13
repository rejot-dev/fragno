// import { customAlphabet } from "nanoid";

// const nanoIdGenerator = customAlphabet("346789ABCDEFGHJKLMNPQRTUVWXYabcdefghijkmnpqrtwxyz", 32);

export function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message ?? "Assertion failed");
  }
}

export function unreachable(value?: never): never {
  if (value) {
    console.warn("Unreachable:", value);
    throw new Error(`Unreachable: ${value}`);
  }

  throw new Error("Unreachable");
}

// export function generateId(prefix: string, length: number = 32): string {
//   if (prefix.length > 4) {
//     throw new Error("Prefix must be 4 characters or less");
//   }

//   if (prefix.length < 2) {
//     throw new Error("Prefix must be at least 2 characters");
//   }

//   if (!/^[a-zA-Z]+$/.test(prefix)) {
//     throw new Error("Prefix must contain only letters");
//   }

//   return `${prefix}_${nanoIdGenerator(length - prefix.length - 1)}`;
// }
