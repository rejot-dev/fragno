import type { LofiSqliteReplica } from "@fragno-dev/lofi/sqlite";
import { useEffect, useEffectEvent, useState } from "react";

export type LofiSqliteReadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: unknown };

/**
 * Reads the replica, and reads again whenever any tab applies outbox entries or `key` changes.
 * Reads never overlap: changes during a read start one more read after it, which sees them all.
 */
export function useLofiSqliteRead<T>(
  replica: LofiSqliteReplica,
  key: string,
  read: (replica: LofiSqliteReplica) => Promise<T>,
): LofiSqliteReadState<T> {
  const [state, setState] = useState<LofiSqliteReadState<T>>({ status: "loading" });
  const readReplica = useEffectEvent(() => read(replica));

  useEffect(() => {
    let active = true;
    let reading = false;
    let stale = false;
    const refresh = async () => {
      if (reading) {
        stale = true;
        return;
      }
      reading = true;
      do {
        stale = false;
        try {
          const data = await readReplica();
          if (active && !stale) {
            setState({ status: "ready", data });
          }
        } catch (error) {
          if (active) {
            setState({ status: "error", error });
          }
          stale = false;
        }
      } while (active && stale);
      reading = false;
    };
    const unsubscribe = replica.subscribe(() => {
      void refresh();
    });
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [replica, key]);

  return state;
}
