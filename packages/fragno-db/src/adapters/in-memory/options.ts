import { createId, init } from "@paralleldrive/cuid2";
import type { SqlNamingStrategy } from "../../naming/sql-naming";
import type { OutboxConfig } from "../../outbox/outbox";

export type InMemoryAdapterOptions = {
  clock?: { now: () => Date };
  idGenerator?: () => string;
  idSeed?: string;
  internalIdGenerator?: () => bigint;
  enforceConstraints?: boolean;
  btreeOrder?: number;
  namingStrategy?: SqlNamingStrategy;
};

export type ResolvedInMemoryAdapterOptions = {
  clock: { now: () => Date };
  idGenerator: () => string;
  idSeed: string;
  internalIdGenerator: () => bigint;
  internalIdGeneratorProvided: boolean;
  enforceConstraints: boolean;
  btreeOrder: number;
  outbox?: OutboxConfig;
};

const defaultClock = {
  now: () => new Date(),
};

const defaultBtreeOrder = 32;
const defaultEnforceConstraints = true;
const initialCountMax = 476782367;
const seededRandomStep = 1831565813;

const createCounter = (start: number) => {
  let value = start;
  return () => value++;
};

const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const createSeededRandom = (seed: string) => {
  let state = hashSeed(seed);
  return () => {
    state |= 0;
    state = (state + seededRandomStep) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const createSeededIdGenerator = (seed: string): (() => string) => {
  const random = createSeededRandom(seed);
  const counter = createCounter(Math.floor(random() * initialCountMax));
  return init({ random, counter });
};

const createInternalIdGenerator = (): (() => bigint) => {
  let current = 0n;
  return () => {
    current += 1n;
    return current;
  };
};

export const resolveInMemoryAdapterOptions = (
  options: InMemoryAdapterOptions = {},
): ResolvedInMemoryAdapterOptions => {
  const idSeed = options.idSeed ?? createId();
  const internalIdGeneratorProvided = options.internalIdGenerator !== undefined;

  return {
    clock: options.clock ?? defaultClock,
    idGenerator: options.idGenerator ?? createSeededIdGenerator(idSeed),
    idSeed,
    internalIdGenerator: options.internalIdGenerator ?? createInternalIdGenerator(),
    internalIdGeneratorProvided,
    enforceConstraints: options.enforceConstraints ?? defaultEnforceConstraints,
    btreeOrder: options.btreeOrder ?? defaultBtreeOrder,
    outbox: undefined,
  };
};
