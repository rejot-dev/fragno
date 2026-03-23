const defaultLength = 24;
const bigLength = 32;
const initialCountMax = 476782367;
const randomPoolSize = 128;
const uint32ToFloatScale = 1 / 4294967296;

const alphabet = "abcdefghijklmnopqrstuvwxyz";
const entropyAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

const createCryptoRandom = (cryptoApi = globalThis.crypto) => {
  if (!cryptoApi?.getRandomValues) {
    throw new Error("Fragno cuid requires globalThis.crypto.getRandomValues()");
  }

  const values = new Uint32Array(randomPoolSize);
  let offset = values.length;

  return () => {
    if (offset >= values.length) {
      cryptoApi.getRandomValues(values);
      offset = 0;
    }

    const value = values[offset]!;
    offset += 1;
    return value * uint32ToFloatScale;
  };
};

const cryptoRandom = (() => {
  let random: (() => number) | undefined;

  return () => {
    random ??= createCryptoRandom();
    return random();
  };
})();

const pickIndex = (random: () => number, length: number) => {
  const value = random();

  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return length - 1;
  }

  return Math.floor(value * length);
};

const createEntropy = (length = 4, random = cryptoRandom) => {
  let entropy = "";

  while (entropy.length < length) {
    entropy += entropyAlphabet[pickIndex(random, entropyAlphabet.length)] ?? "0";
  }

  return entropy;
};

const hash53 = (input: string, seed = 0) => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;

  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

const hash = (input: string, length = bigLength) => {
  let output = "";
  let seed = 0;

  while (output.length < length) {
    output += hash53(`${seed}:${input}`, seed).toString(36);
    seed += 1;
  }

  return output.slice(0, length);
};

const createFingerprint = ({
  random = cryptoRandom,
}: {
  random?: () => number;
} = {}) => createEntropy(bigLength, random);

const createCounter = (count: number) => () => count++;

export const init = ({
  random = cryptoRandom,
  counter,
  length = defaultLength,
  fingerprint,
}: {
  random?: () => number;
  counter?: () => number;
  length?: number;
  fingerprint?: string;
} = {}) => {
  const normalizedLength = Math.max(1, Math.floor(length));
  let resolvedCounter = counter;
  let resolvedFingerprint = fingerprint;

  return () => {
    resolvedCounter ??= createCounter(pickIndex(random, initialCountMax));
    resolvedFingerprint ??= createFingerprint({ random });

    const firstLetter = alphabet[pickIndex(random, alphabet.length)] ?? "a";

    if (normalizedLength === 1) {
      return firstLetter;
    }

    const time = Date.now().toString(36);
    const count = resolvedCounter().toString(36);
    const salt = createEntropy(normalizedLength, random);
    const body = hash(`${time}:${salt}:${count}:${resolvedFingerprint}`, normalizedLength - 1);
    return `${firstLetter}${body}`;
  };
};

// Safe to keep at module scope: init() defers all randomness until the first ID request.
export const createId = init();
