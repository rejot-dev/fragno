import "vitest";

declare module "vitest" {
  interface Assertion<T = any> {
    toBeInTheDocument(): T;
    toHaveAttribute(name: string, value?: string): T;
    toBeDisabled(): T;
    toHaveTextContent(text: string | RegExp): T;
    toBeChecked(): T;
    toHaveValue(value: unknown): T;
  }

  interface AsymmetricMatchersContaining {
    toBeInTheDocument(): void;
    toHaveAttribute(name: string, value?: string): void;
    toBeDisabled(): void;
    toHaveTextContent(text: string | RegExp): void;
    toBeChecked(): void;
    toHaveValue(value: unknown): void;
  }
}
