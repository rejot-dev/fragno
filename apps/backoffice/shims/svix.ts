export class Webhook {
  readonly #secret: string;

  constructor(secret: string) {
    this.#secret = secret;
  }

  verify(payload: string | Readonly<Record<string, unknown>>, _headers: Record<string, string>) {
    void this.#secret;

    if (typeof payload === "string") {
      try {
        return JSON.parse(payload) as unknown;
      } catch {
        return payload;
      }
    }

    return payload;
  }
}
