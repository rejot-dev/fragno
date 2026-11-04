import { ActionItem } from "@fragno-private/design-system/controls/action-item";
import { useEffect, useState, type ReactNode } from "react";
import { Form } from "react-router";

/**
 * Acts on a Connector account through the Connect page's `action`: `start` signs it in with its
 * provider, and `create-workflow` hands a workflow on it to the agent. Naming the account rather than
 * its source lets the overview and a connection's own page offer both.
 */
export function ConnectorActionForm({
  intent,
  action,
  connectionId,
  busy,
  children,
}: {
  intent: "start" | "create-workflow";
  action: string;
  connectionId: string;
  busy: boolean;
  children: ReactNode;
}) {
  // The reader's time zone, which only the browser knows, so the agent schedules in it.
  const [timeZone, setTimeZone] = useState("UTC");
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  return (
    <Form method="post" action={action}>
      <input type="hidden" name="connectionId" value={connectionId} />
      <input type="hidden" name="timeZone" value={timeZone} />
      <ActionItem
        type="submit"
        name="intent"
        value={intent}
        icon={intent === "start" ? "log-in" : "share-2"}
        emphasis="primary"
        disabled={busy}
      >
        {children}
      </ActionItem>
    </Form>
  );
}
