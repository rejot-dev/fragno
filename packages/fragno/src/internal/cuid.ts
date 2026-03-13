const defaultLength = 24;
const bigLength = 32;
const initialCountMax = 476782367;

const alphabet = Array.from({ length: 26 }, (_, index) => String.fromCharCode(index + 97));

const cryptoRandom = () => {
  const cryptoApi = globalThis.crypto;

  if (!cryptoApi?.getRandomValues) {
    throw new Error("Fragno cuid requires globalThis.crypto.getRandomValues()");
  }

  const values = new Uint32Array(1);
  cryptoApi.getRandomValues(values);
  return values[0]! / 4294967296;
};

const createEntropy = (length = 4, random = cryptoRandom) => {
  let entropy = "";

  while (entropy.length < length) {
    entropy += Math.floor(random() * 36).toString(36);
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
  globalObj = globalThis,
  random = cryptoRandom,
}: {
  globalObj?: object;
  random?: () => number;
} = {}) => {
  const globals = Object.keys(globalObj).toString();
  const source = globals.length
    ? `${globals}${createEntropy(bigLength, random)}`
    : createEntropy(bigLength, random);

  return hash(source, bigLength);
};

const createCounter = (count: number) => () => count++;

export const init = ({
  random = cryptoRandom,
  counter = createCounter(Math.floor(random() * initialCountMax)),
  length = defaultLength,
  fingerprint = createFingerprint({ random }),
}: {
  random?: () => number;
  counter?: () => number;
  length?: number;
  fingerprint?: string;
} = {}) => {
  const normalizedLength = Math.max(1, Math.floor(length));

  return () => {
    const firstLetter = alphabet[Math.floor(random() * alphabet.length)] ?? "a";

    if (normalizedLength === 1) {
      return firstLetter;
    }

    const time = Date.now().toString(36);
    const count = counter().toString(36);
    const salt = createEntropy(normalizedLength, random);
    const body = hash(`${time}:${salt}:${count}:${fingerprint}`, normalizedLength - 1);
    return `${firstLetter}${body}`;
  };
};

export const createId = init();
