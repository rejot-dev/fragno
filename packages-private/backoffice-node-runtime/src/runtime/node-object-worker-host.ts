import { RpcTarget } from "capnweb";

/** Worker factories resolve other objects through their owning host, never a second runtime. */
export class NodeObjectWorkerHost extends RpcTarget {
  readonly #resolveObject: (binding: string, name: string) => Promise<RpcTarget>;

  constructor(resolveObject: (binding: string, name: string) => Promise<RpcTarget>) {
    super();
    this.#resolveObject = resolveObject;
  }

  async getObject(binding: string, name: string): Promise<RpcTarget> {
    return await this.#resolveObject(binding, name);
  }
}
