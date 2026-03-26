import { createReson8Fragment } from "@fragno-dev/reson8-fragment";

export type Reson8Config = {
  apiKey: string;
};

export function createReson8Server(config: Reson8Config): ReturnType<typeof createReson8Fragment> {
  return createReson8Fragment(config, {
    mountRoute: "/api/reson8",
  });
}

export type Reson8Fragment = ReturnType<typeof createReson8Server>;
