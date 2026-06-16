import { DurableObject } from "cloudflare:workers";

export default {
  fetch() {
    return new Response("Backoffice Vitest worker");
  },
};

export class OutboxHarnessDurableObject extends DurableObject {
  async alarm() {}
}
