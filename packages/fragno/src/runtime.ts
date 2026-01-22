import { createId } from "@paralleldrive/cuid2";

export type FragnoRuntime = {
  time: {
    now: () => Date;
  };
  random: {
    float: () => number;
    uuid: () => string;
    cuid: () => string;
  };
};

const fallbackUuid = () => {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }

  // RFC 4122 variant + version 4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
};

const defaultUuid = () => {
  const cryptoApi = globalThis.crypto;
  return cryptoApi?.randomUUID ? cryptoApi.randomUUID() : fallbackUuid();
};

export const defaultFragnoRuntime: FragnoRuntime = {
  time: {
    now: () => new Date(),
  },
  random: {
    float: () => Math.random(),
    uuid: () => defaultUuid(),
    cuid: () => createId(),
  },
};
