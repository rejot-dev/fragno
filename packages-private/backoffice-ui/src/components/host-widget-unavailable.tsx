import { Callout } from "@fragno-private/design-system/callout";

/** Stands where a host widget would be, in interfaces that are not pages. */
export function HostWidgetUnavailable({ widget }: { widget: string }) {
  return (
    <Callout tone="muted" title="Shows on Backoffice pages">
      {widget} shows only when this interface is a Backoffice page.
    </Callout>
  );
}
