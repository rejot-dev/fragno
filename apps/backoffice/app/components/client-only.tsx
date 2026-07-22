import { useSyncExternalStore, type ReactNode } from "react";

const subscribe = () => () => undefined;
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function ClientOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const isClient = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
  return isClient ? children : fallback;
}
