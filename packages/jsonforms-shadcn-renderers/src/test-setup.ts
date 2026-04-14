import { expect } from "vitest";

import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

// Mock ResizeObserver for Radix UI components that use it (like Slider)
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;
