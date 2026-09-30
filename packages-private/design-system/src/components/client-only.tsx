import { useSyncExternalStore, type ReactNode } from "react";

const subscribe = () => () => undefined;
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function ClientOnly({
  children,
  fallback = null,
}: {
  children: ReactNode | (() => ReactNode);
  fallback?: ReactNode;
}) {
  const isClient = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
  if (!isClient) {
    return fallback;
  }
  return typeof children === "function" ? children() : children;
}
