import { Button } from "./button";
import { PageHeading } from "./page-heading";

export default { title: "Layout/Page heading" };

export function WithActions() {
  return (
    <PageHeading
      eyebrow="Acme Holding"
      title="Trial balance"
      meta="1 Jan – 31 Mar 2026 · EUR"
      actions={<Button variant="solid">New entry</Button>}
    />
  );
}
