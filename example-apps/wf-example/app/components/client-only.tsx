import { useSyncExternalStore, type ReactNode } from "react";

type ClientOnlyProps = {
  children: ReactNode;
  fallback?: ReactNode;
};

const subscribe = () => () => {};

export function ClientOnly({ children, fallback = null }: ClientOnlyProps) {
  const isClient = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  if (!isClient) {
    return fallback;
  }

  return children;
}
