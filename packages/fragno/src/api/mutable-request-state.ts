import type { RequestBodyType } from "./request-input-context";

/**
 * Holds mutable request state that can be modified by middleware and consumed by handlers.
 *
 * This class provides a structural way for middleware to modify request data:
 * - Path parameters can be modified
 * - Query/search parameters can be modified
 * - Request body can be overridden
 * - Request headers can be modified
 *
 * @example
 * ```typescript
 * // In middleware
 * const state = new MutableRequestState({
 *   pathParams: { id: "123" },
 *   searchParams: new URLSearchParams("?role=user"),
 *   body: { name: "John" },
 *   headers: new Headers()
 * });
 *
 * // Modify query parameters
 * state.searchParams.set("role", "admin");
 *
 * // Override body
 * state.setBody({ name: "Jane" });
 *
 * // Modify headers
 * state.headers.set("X-Custom", "value");
 * ```
 */
export class MutableRequestState {
  readonly #pathParams: Record<string, string>;
  readonly #searchParams: URLSearchParams;
  readonly #headers: Headers;
  // oxlint-disable-next-line no-unused-private-class-members False Positive?
  readonly #initialBody: RequestBodyType;
  #bodyOverride: RequestBodyType | undefined;

  constructor(config: {
    pathParams: Record<string, string>;
    searchParams: URLSearchParams;
    body: RequestBodyType;
    headers: Headers;
  }) {
    this.#pathParams = config.pathParams;
    this.#searchParams = config.searchParams;
    this.#headers = config.headers;
    this.#initialBody = config.body;
    this.#bodyOverride = undefined;
  }

  /**
   * Path parameters extracted from the route.
   * Can be modified directly (e.g., `state.pathParams.id = "456"`).
   */
  get pathParams(): Record<string, string> {
    return this.#pathParams;
  }

  /**
   * URLSearchParams for query parameters.
   * Can be modified using URLSearchParams API (e.g., `state.searchParams.set("key", "value")`).
   */
  get searchParams(): URLSearchParams {
    return this.#searchParams;
  }

  /**
   * Request headers.
   * Can be modified using Headers API (e.g., `state.headers.set("X-Custom", "value")`).
   */
  get headers(): Headers {
    return this.#headers;
  }

  /**
   * Get the current body value.
   * Returns the override if set, otherwise the initial body.
   */
  get body(): RequestBodyType {
    return this.#bodyOverride !== undefined ? this.#bodyOverride : this.#initialBody;
  }

  /**
   * Override the request body.
   * This allows middleware to replace the body that will be seen by the handler.
   *
   * @param body - The new body value
   *
   * @example
   * ```typescript
   * // In middleware
   * state.setBody({ modifiedField: "new value" });
   * ```
   */
  setBody(body: RequestBodyType): void {
    this.#bodyOverride = body;
  }

  /**
   * Check if the body has been overridden by middleware.
   */
  get hasBodyOverride(): boolean {
    return this.#bodyOverride !== undefined;
  }
}
