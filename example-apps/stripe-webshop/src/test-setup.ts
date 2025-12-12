import "@testing-library/jest-dom/vitest";

// Mock ResizeObserver for Radix UI components that use it (like Slider)
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;
